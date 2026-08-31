from __future__ import annotations

import ast
import builtins
import copy
import json
import re
import sys
import tomllib
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote


RULES = [
    "prompt/sdk-packages",
    "prompt/sdk-event-deserialization",
    "prompt/event-routing",
    "prompt/blob-subject-and-summary",
    "prompt/race-condition-handling",
    "prompt/custom-event-publishing",
    "prompt/async-implementations",
    "prompt/secure-client-configuration",
    "prompt/ordered-demo-workflow",
]

TRUSTED_WARNING_ROOTS = {"logging", "warnings", "sys"}
LOOP_FIXPOINT_LIMIT = 8
MUTABLE_VALUE_KINDS = {"dict", "instance", "list", "set"}
ITERABLE_VALUE_KINDS = {"list", "set", "tuple"}
BUILTIN_NAMES = frozenset(vars(builtins))
BUILTIN_EXCEPTION_NAMES = frozenset(
    name
    for name, value in vars(builtins).items()
    if isinstance(value, type) and issubclass(value, BaseException)
)


@dataclass
class Value:
    kind: str = "unknown"
    data: Any = None
    items: tuple[Value, ...] = ()
    tags: frozenset[str] = frozenset()
    attrs: dict[str, Value] = field(default_factory=dict)


@dataclass
class FunctionInfo:
    key: str
    module: str
    node: ast.FunctionDef | ast.AsyncFunctionDef
    class_key: str | None = None
    closure: dict[str, Value] | None = None
    closure_names: frozenset[str] = frozenset()

    @property
    def is_async(self) -> bool:
        return isinstance(self.node, ast.AsyncFunctionDef)

    @property
    def is_async_generator(self) -> bool:
        return self.is_async and function_contains_yield(self.node)


@dataclass
class ClassInfo:
    key: str
    module: str
    node: ast.ClassDef
    methods: dict[str, FunctionInfo]
    fields: list[tuple[str, ast.expr | None]]
    dataclass: bool


@dataclass
class ModuleInfo:
    name: str
    path: str
    is_package: bool
    tree: ast.Module
    postponed_annotations: bool = False
    env: dict[str, Value] = field(default_factory=dict)
    functions: dict[str, FunctionInfo] = field(default_factory=dict)
    classes: dict[str, ClassInfo] = field(default_factory=dict)


@dataclass
class ExecResult:
    returned: bool = False
    broke: bool = False
    continued: bool = False
    value: Value = field(default_factory=Value)
    outcomes: tuple[ExecOutcome, ...] = ()


@dataclass
class ExecOutcome:
    control: str
    path: tuple[tuple[int, bool | str], ...]
    environment: dict[str, Value]
    value: Value = field(default_factory=Value)
    external_state: dict[str, Any] | None = None
    async_continuations: dict[int, dict[str, Any]] = field(default_factory=dict)


@dataclass
class AsyncIteration:
    items: tuple[Value, ...]
    path: tuple[tuple[int, bool | str], ...]
    exhausted: bool
    operations: tuple[tuple[int, dict[str, Any]], ...] = ()
    yield_positions: tuple[int, ...] = ()
    state: dict[str, Any] = field(default_factory=dict)


def unknown(*values: Value) -> Value:
    tags: set[str] = set()
    for value in values:
        tags.update(value.tags)
    return Value(tags=frozenset(tags))


def literal(value: Any) -> Value:
    return Value(kind="literal", data=value)


def abstract_python_value(value: Value) -> Any:
    if value.kind == "literal":
        return value.data
    if value.kind == "dict" and isinstance(value.data, dict):
        converted = {
            key: abstract_python_value(item)
            for key, item in value.data.items()
        }
        return (
            converted
            if all(item is not _UNKNOWN_LITERAL for item in converted.values())
            else _UNKNOWN_LITERAL
        )
    if value.kind in {"list", "tuple"}:
        converted = tuple(abstract_python_value(item) for item in value.items)
        if any(item is _UNKNOWN_LITERAL for item in converted):
            return _UNKNOWN_LITERAL
        return list(converted) if value.kind == "list" else converted
    return _UNKNOWN_LITERAL


def same_value_sequence(
    left: tuple[Value, ...],
    right: tuple[Value, ...],
) -> bool:
    return len(left) == len(right) and all(
        left_value is right_value
        for left_value, right_value in zip(left, right, strict=True)
    )


def same_value_mapping(
    left: dict[Any, Value],
    right: dict[Any, Value],
) -> bool:
    return left.keys() == right.keys() and all(left[key] is right[key] for key in left)


def same_abstract_value(left: Value, right: Value) -> bool:
    if left is right:
        return True
    if left.kind in MUTABLE_VALUE_KINDS or right.kind in MUTABLE_VALUE_KINDS:
        return False
    return left == right


def unique_abstract_values(values: tuple[Value, ...]) -> tuple[Value, ...]:
    unique: list[Value] = []
    for value in values:
        if not any(same_abstract_value(value, existing) for existing in unique):
            unique.append(value)
    return tuple(unique)


def merge_return_values(values: list[Value]) -> Value:
    if not values:
        return Value()
    if len(values) == 1:
        return values[0]
    unique = unique_abstract_values(tuple(values))
    if len(unique) == 1:
        return unique[0]
    valid_events = [
        value
        for value in unique
        if value.kind == "event" and value.data.get("sample_valid")
    ]
    if valid_events and all(
        (
            value.data.get("schema"),
            value.data.get("type"),
            value.data.get("subject"),
        )
        == (
            valid_events[0].data.get("schema"),
            valid_events[0].data.get("type"),
            valid_events[0].data.get("subject"),
        )
        for value in valid_events[1:]
    ):
        return valid_events[0]
    return unknown(*unique)


def iterable_value_items(value: Value) -> tuple[Value, ...] | None:
    if value.kind in ITERABLE_VALUE_KINDS:
        return value.items
    if value.kind == "dict" and isinstance(value.data, dict):
        return tuple(literal(key) for key in value.data)
    if value.kind == "literal" and isinstance(
        value.data,
        (bytes, range, str),
    ):
        return tuple(literal(item) for item in value.data)
    return None


def compare_abstract_values(left: Value, right: Value) -> int | None:
    if left is right:
        return 0
    if left.kind == "literal" and right.kind == "literal":
        try:
            if left.data == right.data:
                return 0
            return -1 if left.data < right.data else 1
        except TypeError:
            return None
    if left.kind in {"list", "tuple"} and right.kind == left.kind:
        for left_item, right_item in zip(left.items, right.items):
            comparison = compare_abstract_values(left_item, right_item)
            if comparison is None or comparison != 0:
                return comparison
        return (len(left.items) > len(right.items)) - (
            len(left.items) < len(right.items)
        )
    if same_abstract_value(left, right):
        return 0
    return None


_UNKNOWN_LITERAL = object()


def static_literal_value(node: ast.expr) -> Any:
    try:
        return ast.literal_eval(node)
    except (TypeError, ValueError):
        return _UNKNOWN_LITERAL


def static_iterable_cardinality(
    node: ast.expr,
    *,
    builtin_available: Any = None,
) -> int | None:
    value = static_literal_value(node)
    if isinstance(value, (bytes, dict, frozenset, list, range, set, str, tuple)):
        return len(value)
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
        return None
    name = node.func.id
    if builtin_available is not None and not builtin_available(name):
        return None
    if name == "range" and not node.keywords and 1 <= len(node.args) <= 3:
        arguments = [static_literal_value(argument) for argument in node.args]
        if all(isinstance(argument, int) for argument in arguments):
            try:
                return len(range(*arguments))
            except ValueError:
                return None
    if (
        name in {"dict", "frozenset", "list", "set", "tuple"}
        and not node.args
        and not node.keywords
    ):
        return 0
    return None


def compile_module(source: str, filename: str) -> ast.Module:
    compile(source, filename, "exec", dont_inherit=True)
    return ast.parse(source, filename=filename)


def function_contains_yield(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> bool:
    found = False

    class YieldVisitor(ast.NodeVisitor):
        def visit_FunctionDef(self, child: ast.FunctionDef) -> None:
            if child is node:
                self.generic_visit(child)

        def visit_AsyncFunctionDef(self, child: ast.AsyncFunctionDef) -> None:
            if child is node:
                self.generic_visit(child)

        def visit_Lambda(self, child: ast.Lambda) -> None:
            return

        def visit_Yield(self, child: ast.Yield) -> None:
            nonlocal found
            found = True

        def visit_YieldFrom(self, child: ast.YieldFrom) -> None:
            nonlocal found
            found = True

    YieldVisitor().visit(node)
    return found


def exception_expression_name(node: ast.expr | None) -> str | None:
    if node is None:
        return None
    target = node.func if isinstance(node, ast.Call) else node
    return dotted(target)


def expression_contains_yield(expression: ast.AST | None) -> bool:
    if expression is None:
        return False
    found = False

    class YieldVisitor(ast.NodeVisitor):
        def visit_FunctionDef(self, child: ast.FunctionDef) -> None:
            return

        def visit_AsyncFunctionDef(
            self,
            child: ast.AsyncFunctionDef,
        ) -> None:
            return

        def visit_Lambda(self, child: ast.Lambda) -> None:
            return

        def visit_Yield(self, child: ast.Yield) -> None:
            nonlocal found
            found = True

        def visit_YieldFrom(self, child: ast.YieldFrom) -> None:
            nonlocal found
            found = True

    YieldVisitor().visit(expression)
    return found


def handler_matches_exception(
    handler: ast.ExceptHandler,
    exception_name: str | None,
) -> bool | None:
    if handler.type is None:
        return True
    handled = (
        handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
    )
    names = {
        name.rsplit(".", 1)[-1]
        for candidate in handled
        if (name := dotted(candidate)) is not None
    }
    if exception_name is None:
        return None
    raised = exception_name.rsplit(".", 1)[-1]
    if raised in names or names & {"BaseException", "Exception"}:
        return True
    return False


def async_generator_behavior(
    node: ast.AsyncFunctionDef,
) -> tuple[bool, bool, bool]:
    def statement_flows(
        statement: ast.stmt,
        yielded: bool,
    ) -> set[tuple[str, bool, str | None]]:
        if isinstance(statement, ast.Raise):
            return {
                (
                    "exception",
                    yielded,
                    exception_expression_name(statement.exc),
                )
            }
        if isinstance(statement, ast.Return):
            return {("exhausted", yielded, None)}
        if isinstance(statement, ast.Break):
            return {("break", yielded, None)}
        if isinstance(statement, ast.Continue):
            return {("continue", yielded, None)}
        if isinstance(statement, ast.If):
            condition = static_literal_truth(statement.test)
            branches = []
            if condition is not False:
                branches.append(statement.body)
            if condition is not True:
                branches.append(statement.orelse)
            return {
                outcome
                for branch in branches
                for outcome in block_flows(branch, yielded)
            }
        if isinstance(statement, (ast.Try, ast.TryStar)):
            attempted = block_flows(statement.body, yielded)
            handled: set[tuple[str, bool, str | None]] = set()
            for control, state_yielded, exception_name in attempted:
                if control == "normal":
                    handled.update(block_flows(statement.orelse, state_yielded))
                    continue
                if control != "exception":
                    handled.add((control, state_yielded, exception_name))
                    continue

                matched = False
                uncertain = False
                for handler in statement.handlers:
                    match = handler_matches_exception(
                        handler,
                        exception_name,
                    )
                    if match is False:
                        continue
                    handled.update(block_flows(handler.body, state_yielded))
                    matched = matched or match is True
                    uncertain = uncertain or match is None
                    if match is True:
                        break
                if not matched:
                    handled.add(("exception", state_yielded, exception_name))
                elif uncertain:
                    handled.add(("exception", state_yielded, exception_name))

            finalized: set[tuple[str, bool, str | None]] = set()
            for control, state_yielded, exception_name in handled:
                final = block_flows(statement.finalbody, state_yielded)
                for final_control, final_yielded, final_exception in final:
                    finalized.add(
                        (
                            control if final_control == "normal" else final_control,
                            final_yielded,
                            (
                                exception_name
                                if final_control == "normal"
                                else final_exception
                            ),
                        )
                    )
            return finalized
        if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            outcomes: set[tuple[str, bool, str | None]] = set()
            condition = (
                static_literal_truth(statement.test)
                if isinstance(statement, ast.While)
                else None
            )
            if condition is not True:
                outcomes.update(block_flows(statement.orelse, yielded))
            if condition is not False:
                for control, state_yielded, exception_name in block_flows(
                    statement.body,
                    yielded,
                ):
                    if control == "break":
                        outcomes.add(("normal", state_yielded, None))
                    elif control in {"normal", "continue"}:
                        if isinstance(statement, ast.While) and condition is True:
                            outcomes.add(("halt", state_yielded, None))
                        else:
                            outcomes.update(
                                block_flows(statement.orelse, state_yielded)
                            )
                    else:
                        outcomes.add((control, state_yielded, exception_name))
            return outcomes
        return {
            (
                "normal",
                yielded or expression_contains_yield(statement),
                None,
            )
        }

    def block_flows(
        statements: list[ast.stmt],
        yielded: bool,
    ) -> set[tuple[str, bool, str | None]]:
        states = {("normal", yielded, None)}
        for statement in statements:
            next_states: set[tuple[str, bool, str | None]] = set()
            for control, state_yielded, exception_name in states:
                if control != "normal":
                    next_states.add((control, state_yielded, exception_name))
                    continue
                next_states.update(statement_flows(statement, state_yielded))
            states = next_states
        return states

    outcomes = block_flows(node.body, False)
    may_yield = any(yielded for _, yielded, _ in outcomes)
    may_exhaust_before_yield = any(
        control in {"normal", "exhausted"} and not yielded
        for control, yielded, _ in outcomes
    )
    may_exhaust_after_yield = any(
        control in {"normal", "exhausted"} and yielded
        for control, yielded, _ in outcomes
    )
    return (
        may_yield,
        may_exhaust_before_yield,
        may_exhaust_after_yield,
    )


def statements_may_break_loop(statements: list[ast.stmt]) -> bool:
    class BreakVisitor(ast.NodeVisitor):
        found = False

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            return

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            return

        def visit_Lambda(self, node: ast.Lambda) -> None:
            return

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            return

        def visit_For(self, node: ast.For) -> None:
            return

        def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
            return

        def visit_While(self, node: ast.While) -> None:
            return

        def visit_Break(self, node: ast.Break) -> None:
            self.found = True

    visitor = BreakVisitor()
    for statement in statements:
        visitor.visit(statement)
    return visitor.found


def loop_body_may_resume(statements: list[ast.stmt]) -> bool:
    def statement_controls(statement: ast.stmt) -> set[str]:
        if isinstance(statement, ast.Break):
            return {"break"}
        if isinstance(statement, ast.Continue):
            return {"continue"}
        if isinstance(statement, ast.Return):
            return {"return"}
        if isinstance(statement, ast.Raise):
            return {"exception"}
        if isinstance(statement, ast.If):
            condition = static_literal_truth(statement.test)
            controls: set[str] = set()
            if condition is not False:
                controls.update(block_controls(statement.body))
            if condition is not True:
                controls.update(block_controls(statement.orelse))
            return controls
        if isinstance(statement, (ast.With, ast.AsyncWith)):
            return block_controls(statement.body)
        if isinstance(statement, (ast.Try, ast.TryStar)):
            attempted = block_controls(statement.body)
            branches: set[str] = set()
            for control in attempted:
                if control == "normal":
                    branches.update(block_controls(statement.orelse))
                elif control == "exception":
                    branches.add("exception")
                    for handler in statement.handlers:
                        branches.update(block_controls(handler.body))
                else:
                    branches.add(control)
            if not statement.finalbody:
                return branches
            finalized: set[str] = set()
            final_controls = block_controls(statement.finalbody)
            for control in branches:
                for final_control in final_controls:
                    finalized.add(
                        control if final_control == "normal" else final_control
                    )
            return finalized
        if isinstance(statement, ast.Match):
            subject = static_literal_value(statement.subject)
            controls: set[str] = set()
            exhaustive = False
            for case in statement.cases:
                matches = static_match_pattern(case.pattern, subject)
                if matches is False:
                    continue
                guard = (
                    static_literal_truth(case.guard) if case.guard is not None else True
                )
                if guard is False:
                    continue
                controls.update(block_controls(case.body))
                if matches is True and guard is True:
                    exhaustive = True
                    break
            if not exhaustive:
                controls.add("normal")
            return controls
        if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            condition = (
                static_literal_truth(statement.test)
                if isinstance(statement, ast.While)
                else None
            )
            controls: set[str] = set()
            if condition is not True:
                controls.update(block_controls(statement.orelse))
            if condition is not False:
                for control in block_controls(statement.body):
                    if control == "break":
                        controls.add("normal")
                    elif control in {"normal", "continue"}:
                        if not (isinstance(statement, ast.While) and condition is True):
                            controls.update(block_controls(statement.orelse))
                    else:
                        controls.add(control)
            return controls
        return {"normal"}

    def block_controls(block: list[ast.stmt]) -> set[str]:
        controls = {"normal"}
        for statement in block:
            next_controls: set[str] = set()
            for control in controls:
                if control == "normal":
                    next_controls.update(statement_controls(statement))
                else:
                    next_controls.add(control)
            controls = next_controls
        return controls

    return bool(block_controls(statements) & {"normal", "continue"})


def function_scope_declarations(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> tuple[set[str], set[str]]:
    globals_: set[str] = set()
    nonlocals: set[str] = set()

    class ScopeVisitor(ast.NodeVisitor):
        def visit_FunctionDef(self, child: ast.FunctionDef) -> None:
            if child is node:
                self.generic_visit(child)

        def visit_AsyncFunctionDef(self, child: ast.AsyncFunctionDef) -> None:
            if child is node:
                self.generic_visit(child)

        def visit_ClassDef(self, child: ast.ClassDef) -> None:
            return

        def visit_Lambda(self, child: ast.Lambda) -> None:
            return

        def visit_Global(self, child: ast.Global) -> None:
            globals_.update(child.names)

        def visit_Nonlocal(self, child: ast.Nonlocal) -> None:
            nonlocals.update(child.names)

    ScopeVisitor().visit(node)
    return globals_, nonlocals


def postpones_annotations(tree: ast.Module) -> bool:
    return any(
        isinstance(statement, ast.ImportFrom)
        and statement.module == "__future__"
        and any(alias.name == "annotations" for alias in statement.names)
        for statement in tree.body
    )


def function_annotation_expressions(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> list[ast.expr]:
    expressions = [
        argument.annotation
        for argument in (
            *node.args.posonlyargs,
            *node.args.args,
            *node.args.kwonlyargs,
        )
        if argument.annotation is not None
    ]
    if node.args.vararg and node.args.vararg.annotation is not None:
        expressions.append(node.args.vararg.annotation)
    if node.args.kwarg and node.args.kwarg.annotation is not None:
        expressions.append(node.args.kwarg.annotation)
    if node.returns is not None:
        expressions.append(node.returns)
    return expressions


def compare_literal_values(left: Any, operator: ast.cmpop, right: Any) -> bool | None:
    try:
        if isinstance(operator, ast.Eq):
            return left == right
        if isinstance(operator, ast.NotEq):
            return left != right
        if isinstance(operator, ast.Is):
            return left is right
        if isinstance(operator, ast.IsNot):
            return left is not right
        if isinstance(operator, ast.Lt):
            return left < right
        if isinstance(operator, ast.LtE):
            return left <= right
        if isinstance(operator, ast.Gt):
            return left > right
        if isinstance(operator, ast.GtE):
            return left >= right
        if isinstance(operator, ast.In):
            return left in right
        if isinstance(operator, ast.NotIn):
            return left not in right
    except (TypeError, ValueError):
        return None
    return None


def static_literal_truth(
    node: ast.expr,
    *,
    root: bool | None = None,
) -> bool | None:
    if isinstance(node, ast.Name) and node.id == "TYPE_CHECKING" and root is not None:
        return False
    if (
        root is not None
        and isinstance(node, ast.Compare)
        and len(node.ops) == 1
        and len(node.comparators) == 1
    ):
        left, right = node.left, node.comparators[0]
        main_comparison = (
            isinstance(left, ast.Name)
            and left.id == "__name__"
            and isinstance(right, ast.Constant)
            and right.value == "__main__"
        ) or (
            isinstance(right, ast.Name)
            and right.id == "__name__"
            and isinstance(left, ast.Constant)
            and left.value == "__main__"
        )
        if main_comparison:
            if isinstance(node.ops[0], (ast.Eq, ast.Is)):
                return root
            if isinstance(node.ops[0], (ast.NotEq, ast.IsNot)):
                return not root

    value = static_literal_value(node)
    if value is not _UNKNOWN_LITERAL:
        return bool(value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        operand = static_literal_truth(node.operand, root=root)
        return None if operand is None else not operand
    if isinstance(node, ast.BoolOp):
        unknown_value = False
        for item in node.values:
            truth = static_literal_truth(item, root=root)
            if isinstance(node.op, ast.And) and truth is False:
                return False
            if isinstance(node.op, ast.Or) and truth is True:
                return True
            unknown_value = unknown_value or truth is None
        if unknown_value:
            return None
        return isinstance(node.op, ast.And)
    if isinstance(node, ast.IfExp):
        condition = static_literal_truth(node.test, root=root)
        if condition is True:
            return static_literal_truth(node.body, root=root)
        if condition is False:
            return static_literal_truth(node.orelse, root=root)
        return None
    if isinstance(node, ast.Compare):
        values = [static_literal_value(item) for item in (node.left, *node.comparators)]
        if _UNKNOWN_LITERAL in values:
            return None
        for left, operator, right in zip(values, node.ops, values[1:]):
            result = compare_literal_values(left, operator, right)
            if result is None:
                return None
            if not result:
                return False
        return True
    return None


def static_match_pattern(pattern: ast.pattern, subject: Any) -> bool | None:
    if isinstance(pattern, ast.MatchValue):
        expected = static_literal_value(pattern.value)
        if expected is _UNKNOWN_LITERAL or subject is _UNKNOWN_LITERAL:
            return None
        try:
            return subject == expected
        except (TypeError, ValueError):
            return None
    if isinstance(pattern, ast.MatchSingleton):
        if subject is _UNKNOWN_LITERAL:
            return None
        return subject is pattern.value
    if isinstance(pattern, ast.MatchOr):
        results = [static_match_pattern(item, subject) for item in pattern.patterns]
        if any(result is True for result in results):
            return True
        if all(result is False for result in results):
            return False
        return None
    if isinstance(pattern, ast.MatchAs):
        if pattern.pattern is None:
            return True
        return static_match_pattern(pattern.pattern, subject)
    if isinstance(pattern, ast.MatchStar):
        return True
    if isinstance(pattern, ast.MatchSequence):
        if subject is _UNKNOWN_LITERAL:
            return None
        if not isinstance(subject, (list, tuple)):
            return False
        star_indexes = [
            index
            for index, item in enumerate(pattern.patterns)
            if isinstance(item, ast.MatchStar)
        ]
        if len(star_indexes) > 1:
            return None
        if not star_indexes and len(pattern.patterns) != len(subject):
            return False
        if star_indexes and len(subject) < len(pattern.patterns) - 1:
            return False
        pairs: list[tuple[ast.pattern, Any]] = []
        if star_indexes:
            star = star_indexes[0]
            suffix = len(pattern.patterns) - star - 1
            pairs.extend(zip(pattern.patterns[:star], subject[:star]))
            if suffix:
                pairs.extend(zip(pattern.patterns[star + 1 :], subject[-suffix:]))
        else:
            pairs.extend(zip(pattern.patterns, subject))
        results = [
            static_match_pattern(item_pattern, item) for item_pattern, item in pairs
        ]
        if any(result is False for result in results):
            return False
        return True if all(result is True for result in results) else None
    if isinstance(pattern, ast.MatchMapping):
        if subject is _UNKNOWN_LITERAL:
            return None
        if not isinstance(subject, dict):
            return False
        results: list[bool | None] = []
        for key_node, value_pattern in zip(pattern.keys, pattern.patterns):
            key = static_literal_value(key_node)
            if key is _UNKNOWN_LITERAL:
                results.append(None)
            elif key not in subject:
                return False
            else:
                results.append(static_match_pattern(value_pattern, subject[key]))
        if any(result is False for result in results):
            return False
        return True if all(result is True for result in results) else None
    if isinstance(pattern, ast.MatchClass):
        if subject is _UNKNOWN_LITERAL:
            return None
        class_name = dotted(pattern.cls)
        builtins = {
            "bool": bool,
            "bytes": bytes,
            "dict": dict,
            "float": float,
            "frozenset": frozenset,
            "int": int,
            "list": list,
            "set": set,
            "str": str,
            "tuple": tuple,
        }
        if class_name in builtins:
            return isinstance(subject, builtins[class_name])
        return None
    return None


def match_bound_names(pattern: ast.pattern) -> set[str]:
    names: set[str] = set()
    if isinstance(pattern, ast.MatchAs):
        if pattern.name:
            names.add(pattern.name)
        if pattern.pattern:
            names.update(match_bound_names(pattern.pattern))
    elif isinstance(pattern, ast.MatchStar):
        if pattern.name:
            names.add(pattern.name)
    elif isinstance(pattern, ast.MatchSequence):
        for item in pattern.patterns:
            names.update(match_bound_names(item))
    elif isinstance(pattern, ast.MatchMapping):
        for item in pattern.patterns:
            names.update(match_bound_names(item))
        if pattern.rest:
            names.add(pattern.rest)
    elif isinstance(pattern, ast.MatchClass):
        for item in (*pattern.patterns, *pattern.kwd_patterns):
            names.update(match_bound_names(item))
    elif isinstance(pattern, ast.MatchOr):
        for item in pattern.patterns:
            names.update(match_bound_names(item))
    return names


def function_local_bindings(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
) -> set[str]:
    bindings = {
        argument.arg
        for argument in (
            *node.args.posonlyargs,
            *node.args.args,
            *node.args.kwonlyargs,
        )
    }
    if node.args.vararg:
        bindings.add(node.args.vararg.arg)
    if node.args.kwarg:
        bindings.add(node.args.kwarg.arg)
    globals_: set[str] = set()
    nonlocals: set[str] = set()

    def add_target(target: ast.expr) -> None:
        if isinstance(target, ast.Name):
            bindings.add(target.id)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                add_target(item)
        elif isinstance(target, ast.Starred):
            add_target(target.value)

    class BindingVisitor(ast.NodeVisitor):
        def visit_FunctionDef(self, child: ast.FunctionDef) -> None:
            bindings.add(child.name)

        def visit_AsyncFunctionDef(self, child: ast.AsyncFunctionDef) -> None:
            bindings.add(child.name)

        def visit_ClassDef(self, child: ast.ClassDef) -> None:
            bindings.add(child.name)

        def visit_Lambda(self, child: ast.Lambda) -> None:
            return

        def visit_Global(self, child: ast.Global) -> None:
            globals_.update(child.names)

        def visit_Nonlocal(self, child: ast.Nonlocal) -> None:
            nonlocals.update(child.names)

        def visit_Import(self, child: ast.Import) -> None:
            for alias in child.names:
                bindings.add(alias.asname or alias.name.split(".", 1)[0])

        def visit_ImportFrom(self, child: ast.ImportFrom) -> None:
            for alias in child.names:
                if alias.name != "*":
                    bindings.add(alias.asname or alias.name)

        def visit_Assign(self, child: ast.Assign) -> None:
            for target in child.targets:
                add_target(target)
            self.visit(child.value)

        def visit_AnnAssign(self, child: ast.AnnAssign) -> None:
            add_target(child.target)
            if child.value:
                self.visit(child.value)

        def visit_AugAssign(self, child: ast.AugAssign) -> None:
            add_target(child.target)
            self.visit(child.value)

        def visit_NamedExpr(self, child: ast.NamedExpr) -> None:
            add_target(child.target)
            self.visit(child.value)

        def visit_Delete(self, child: ast.Delete) -> None:
            for target in child.targets:
                add_target(target)

        def visit_For(self, child: ast.For) -> None:
            add_target(child.target)
            self.generic_visit(child)

        def visit_AsyncFor(self, child: ast.AsyncFor) -> None:
            add_target(child.target)
            self.generic_visit(child)

        def visit_With(self, child: ast.With) -> None:
            for item in child.items:
                if item.optional_vars:
                    add_target(item.optional_vars)
            self.generic_visit(child)

        def visit_AsyncWith(self, child: ast.AsyncWith) -> None:
            for item in child.items:
                if item.optional_vars:
                    add_target(item.optional_vars)
            self.generic_visit(child)

        def visit_ExceptHandler(self, child: ast.ExceptHandler) -> None:
            if child.name:
                bindings.add(child.name)
            self.generic_visit(child)

        def visit_Match(self, child: ast.Match) -> None:
            for case in child.cases:
                bindings.update(match_bound_names(case.pattern))
            self.generic_visit(child)

        def visit_ListComp(self, child: ast.ListComp) -> None:
            self.visit(child.elt)
            for generator in child.generators:
                self.visit(generator.iter)
                for condition in generator.ifs:
                    self.visit(condition)

        visit_SetComp = visit_ListComp
        visit_GeneratorExp = visit_ListComp

        def visit_DictComp(self, child: ast.DictComp) -> None:
            self.visit(child.key)
            self.visit(child.value)
            for generator in child.generators:
                self.visit(generator.iter)
                for condition in generator.ifs:
                    self.visit(condition)

    visitor = BindingVisitor()
    for statement in node.body:
        visitor.visit(statement)
    return bindings - globals_ - nonlocals


def value_truth(value: Value) -> bool | None:
    if value.kind == "literal":
        return bool(value.data)
    if value.kind in ITERABLE_VALUE_KINDS:
        return bool(value.items)
    if value.kind == "dict":
        return bool(value.data)
    return None


def tagged(value: Value, tag: str) -> Value:
    if value.kind in MUTABLE_VALUE_KINDS:
        value.tags = frozenset(set(value.tags) | {tag})
        return value
    return Value(
        kind=value.kind,
        data=value.data,
        items=value.items,
        tags=frozenset(set(value.tags) | {tag}),
        attrs=value.attrs,
    )


def with_tags(value: Value, tags: frozenset[str]) -> Value:
    if not tags:
        return value
    return Value(
        kind=value.kind,
        data=value.data,
        items=value.items,
        tags=frozenset(set(value.tags) | set(tags)),
        attrs=value.attrs,
    )


def value_tags(value: Value, seen: set[int] | None = None) -> frozenset[str]:
    if seen is None:
        seen = set()
    if id(value) in seen:
        return frozenset()
    seen.add(id(value))
    tags = set(value.tags)
    for item in value.items:
        tags.update(value_tags(item, seen))
    for item in value.attrs.values():
        tags.update(value_tags(item, seen))
    return frozenset(tags)


def input_parameter_names(value: Value) -> set[str]:
    return {
        tag.rsplit(":", 1)[-1].lower()
        for tag in value_tags(value)
        if tag.startswith("input:")
    }


def has_subject_input(value: Value) -> bool:
    names = input_parameter_names(value)
    return any(
        "subject" in name
        or name in {"filter_path", "filterpath", "event_path", "eventpath"}
        for name in names
    )


def has_data_input(value: Value) -> bool:
    names = input_parameter_names(value)
    return any(
        any(
            marker in name
            for marker in (
                "data",
                "payload",
                "notification",
                "event",
                "item",
                "message",
                "content",
                "detail",
                "body",
            )
        )
        and "subject" not in name
        for name in names
    )


def valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def valid_event_grid_sample(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("id"), str)
        and bool(value["id"].strip())
        and isinstance(value.get("eventType"), str)
        and bool(value["eventType"].strip())
        and isinstance(value.get("subject"), str)
        and bool(value["subject"].strip())
        and valid_timestamp(value.get("eventTime"))
        and isinstance(value.get("data"), dict)
        and isinstance(value.get("dataVersion"), str)
        and isinstance(value.get("metadataVersion"), str)
        and isinstance(value.get("topic"), str)
        and bool(value["topic"].strip())
    )


def valid_cloud_event_sample(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and value.get("specversion") == "1.0"
        and isinstance(value.get("id"), str)
        and bool(value["id"].strip())
        and isinstance(value.get("source"), str)
        and bool(value["source"].strip())
        and isinstance(value.get("type"), str)
        and bool(value["type"].strip())
        and isinstance(value.get("subject"), str)
        and bool(value["subject"].strip())
        and isinstance(value.get("data"), dict)
        and ("time" not in value or valid_timestamp(value.get("time")))
        and (
            "datacontenttype" not in value
            or (
                isinstance(value.get("datacontenttype"), str)
                and bool(value["datacontenttype"].strip())
            )
        )
    )


def dotted(node: ast.expr) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        if parent:
            return f"{parent}.{node.attr}"
    return None


def module_name(path: str) -> str:
    normalized = path.replace("\\", "/")
    without_suffix = normalized[:-3] if normalized.endswith(".py") else normalized
    parts = [part for part in without_suffix.split("/") if part and part != "__init__"]
    return ".".join(parts)


def discover_application_paths(
    documents: list[dict[str, str]],
    application_paths: list[str],
) -> list[str]:
    modules: dict[str, tuple[str, bool, ast.Module | None]] = {}
    future_annotations: dict[str, bool] = {}
    definitions: dict[str, dict[str, tuple[Any, ...]]] = {}
    class_methods: dict[tuple[str, str], dict[str, tuple[Any, ...]]] = {}
    node_bindings: dict[int, tuple[Any, ...]] = {}

    for document in documents:
        path = str(document.get("path", ""))
        name = module_name(path)
        if not name:
            continue
        try:
            tree = compile_module(str(document.get("source", "")), path)
        except (SyntaxError, TypeError, ValueError):
            tree = None
        modules[name] = (
            path,
            path.replace("\\", "/").endswith("/__init__.py"),
            tree,
        )
        future_annotations[name] = bool(tree and postpones_annotations(tree))

    for name, (_, _, tree) in modules.items():
        module_definitions: dict[str, tuple[Any, ...]] = {}
        if tree is not None:
            for statement in tree.body:
                if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    binding = ("function", name, statement)
                    module_definitions[statement.name] = binding
                    node_bindings[id(statement)] = binding
                elif isinstance(statement, ast.ClassDef):
                    binding = ("class", name, statement.name, statement)
                    module_definitions[statement.name] = binding
                    node_bindings[id(statement)] = binding
                    methods: dict[str, tuple[Any, ...]] = {}
                    for member in statement.body:
                        if isinstance(
                            member,
                            (ast.FunctionDef, ast.AsyncFunctionDef),
                        ):
                            method = (
                                "function",
                                name,
                                member,
                                statement.name,
                            )
                            methods[member.name] = method
                            node_bindings[id(member)] = method
                    class_methods[(name, statement.name)] = methods
        definitions[name] = module_definitions

    connected: set[str] = set()
    queued_modules: list[tuple[str, bool]] = []
    queued_functions: list[tuple[tuple[Any, ...], bool]] = []
    processed_modules: set[tuple[str, bool]] = set()
    processed_functions: set[tuple[int, bool]] = set()
    active_global_names: set[str] = set()
    suspend_on_yield = False
    module_environments = {
        name: dict(module_definitions)
        for name, module_definitions in definitions.items()
    }

    def connect_module(name: str, as_root: bool = False) -> None:
        if name not in modules:
            return
        parts = name.split(".")
        for index in range(1, len(parts)):
            parent = ".".join(parts[:index])
            if parent in modules and modules[parent][1]:
                if parent not in connected:
                    connected.add(parent)
                queued_modules.append((parent, False))
        if name not in connected:
            connected.add(name)
        queued_modules.append((name, as_root))

    root_modules = {
        module_name(path) for path in application_paths if module_name(path) in modules
    }
    for name in sorted(root_modules):
        connect_module(name, True)

    def absolute_import_name(
        current_module: str,
        is_package: bool,
        imported_module: str | None,
        level: int,
    ) -> str:
        if level == 0:
            return imported_module or ""
        package = current_module.split(".")
        if not is_package:
            package = package[:-1]
        trim = max(0, level - 1)
        if trim:
            package = package[: max(0, len(package) - trim)]
        if imported_module:
            package.extend(imported_module.split("."))
        return ".".join(package)

    def imported_binding(
        imported_module: str, symbol: str | None = None
    ) -> tuple[Any, ...]:
        if symbol is not None:
            nested = f"{imported_module}.{symbol}" if imported_module else symbol
            if nested in modules:
                return ("module", nested)
            return definitions.get(imported_module, {}).get(
                symbol,
                ("external", nested),
            )
        if imported_module in modules:
            return ("module", imported_module)
        return ("external", imported_module)

    def static_truth(node: ast.expr, *, root: bool) -> bool | None:
        return static_literal_truth(node, root=root)

    def resolve_expression(
        node: ast.expr,
        environment: dict[str, tuple[Any, ...]],
        current_module: str,
    ) -> tuple[Any, ...]:
        literal_value = static_literal_value(node)
        if literal_value is not _UNKNOWN_LITERAL:
            return ("literal", literal_value)
        if isinstance(node, ast.Name):
            return environment.get(node.id, ("unknown",))
        if isinstance(node, ast.Attribute):
            receiver = resolve_expression(node.value, environment, current_module)
            if receiver[0] == "module":
                return imported_binding(str(receiver[1]), node.attr)
            if receiver[0] in {"external", "event-loop", "async-task-group"}:
                return ("external", f"{receiver[1]}.{node.attr}")
            if receiver[0] == "class":
                return class_methods.get(
                    (str(receiver[1]), str(receiver[2])),
                    {},
                ).get(node.attr, ("unknown",))
            if receiver[0] == "instance":
                return class_methods.get(
                    (str(receiver[1]), str(receiver[2])),
                    {},
                ).get(node.attr, ("unknown",))
        if isinstance(node, ast.Call):
            callee = resolve_expression(node.func, environment, current_module)
            if callee[0] == "class":
                return ("instance", callee[1], callee[2])
            if callee[0] == "function":
                function_node = callee[2]
                if isinstance(function_node, ast.AsyncFunctionDef):
                    return (
                        "async-iterable"
                        if function_contains_yield(function_node)
                        else "coroutine",
                        callee,
                    )
            if callee[0] == "external" and callee[1] in {
                "asyncio.get_event_loop",
                "asyncio.get_running_loop",
                "asyncio.new_event_loop",
            }:
                return ("event-loop", "asyncio.loop")
            if callee[0] == "external" and callee[1] == "asyncio.TaskGroup":
                return ("async-task-group", "asyncio.TaskGroup")
        return ("unknown",)

    def queue_calls(
        node: ast.AST,
        environment: dict[str, tuple[Any, ...]],
        current_module: str,
        *,
        consume_coroutine: bool = False,
    ) -> None:
        if isinstance(node, ast.Await):
            queue_calls(
                node.value,
                environment,
                current_module,
                consume_coroutine=True,
            )
            return
        if isinstance(node, ast.Call):
            target = resolve_expression(node.func, environment, current_module)
            origin = str(target[1]) if target[0] == "external" else ""
            consumes_arguments = origin in {
                "asyncio.create_task",
                "asyncio.ensure_future",
                "asyncio.gather",
                "asyncio.run",
                "asyncio.run_coroutine_threadsafe",
                "asyncio.shield",
                "asyncio.wait",
                "asyncio.loop.create_task",
                "asyncio.loop.run_until_complete",
                "asyncio.TaskGroup.create_task",
            }
            queue_calls(node.func, environment, current_module)
            for argument in node.args:
                queue_calls(
                    argument,
                    environment,
                    current_module,
                    consume_coroutine=consumes_arguments,
                )
            for keyword in node.keywords:
                queue_calls(
                    keyword.value,
                    environment,
                    current_module,
                    consume_coroutine=consumes_arguments,
                )
            if target[0] == "function":
                function_node = target[2]
                if not isinstance(function_node, ast.AsyncFunctionDef) or (
                    consume_coroutine and not function_contains_yield(function_node)
                ):
                    queued_functions.append((target, False))
            elif target[0] == "class":
                initializer = class_methods.get(
                    (str(target[1]), str(target[2])),
                    {},
                ).get("__init__")
                if initializer is not None:
                    queued_functions.append((initializer, False))
            return
        for child in ast.iter_child_nodes(node):
            if isinstance(
                child,
                (
                    ast.FunctionDef,
                    ast.AsyncFunctionDef,
                    ast.ClassDef,
                    ast.Lambda,
                ),
            ):
                continue
            queue_calls(
                child,
                environment,
                current_module,
                consume_coroutine=consume_coroutine,
            )

    def bind_target(
        target: ast.expr,
        value: tuple[Any, ...],
        environment: dict[str, tuple[Any, ...]],
        current_module: str,
    ) -> None:
        if isinstance(target, ast.Name):
            environment[target.id] = value
            if target.id in active_global_names:
                module_environments[current_module][target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                bind_target(item, ("unknown",), environment, current_module)

    def delete_target(
        target: ast.expr,
        environment: dict[str, tuple[Any, ...]],
        current_module: str,
    ) -> None:
        if isinstance(target, ast.Name):
            environment[target.id] = ("deleted",)
            if target.id in active_global_names:
                module_environments[current_module][target.id] = ("deleted",)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                delete_target(item, environment, current_module)

    def process_statements(
        statements: list[ast.stmt],
        environment: dict[str, tuple[Any, ...]],
        current_module: str,
        *,
        root: bool,
    ) -> bool:
        is_package = modules[current_module][1]
        for statement in statements:
            if suspend_on_yield:
                direct_expressions: list[ast.expr] = []
                if isinstance(statement, ast.Expr):
                    direct_expressions = [statement.value]
                elif isinstance(statement, ast.Assign):
                    direct_expressions = [statement.value]
                elif isinstance(statement, ast.AnnAssign):
                    direct_expressions = (
                        [statement.value] if statement.value is not None else []
                    )
                elif isinstance(statement, ast.AugAssign):
                    direct_expressions = [statement.value]
                elif isinstance(statement, (ast.If, ast.While)):
                    direct_expressions = [statement.test]
                elif isinstance(statement, (ast.For, ast.AsyncFor)):
                    direct_expressions = [statement.iter]
                elif isinstance(statement, (ast.With, ast.AsyncWith)):
                    direct_expressions = [item.context_expr for item in statement.items]
                elif isinstance(statement, ast.Return):
                    direct_expressions = (
                        [statement.value] if statement.value is not None else []
                    )
                elif isinstance(statement, ast.Raise):
                    direct_expressions = (
                        [statement.exc] if statement.exc is not None else []
                    )
                yielding = [
                    expression
                    for expression in direct_expressions
                    if expression_contains_yield(expression)
                ]
                if yielding:
                    for expression in yielding:
                        queue_calls(expression, environment, current_module)
                    return True
            if isinstance(statement, ast.Import):
                for alias in statement.names:
                    connect_module(alias.name)
                    bound = alias.asname or alias.name.split(".", 1)[0]
                    imported = (
                        alias.name if alias.asname else alias.name.split(".", 1)[0]
                    )
                    environment[bound] = imported_binding(imported)
            elif isinstance(statement, ast.ImportFrom):
                imported_module = absolute_import_name(
                    current_module,
                    is_package,
                    statement.module,
                    statement.level,
                )
                connect_module(imported_module)
                for alias in statement.names:
                    if alias.name == "*":
                        continue
                    nested = (
                        f"{imported_module}.{alias.name}"
                        if imported_module
                        else alias.name
                    )
                    connect_module(nested)
                    environment[alias.asname or alias.name] = imported_binding(
                        imported_module,
                        alias.name,
                    )
            elif isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for expression in (
                    *statement.decorator_list,
                    *statement.args.defaults,
                    *(
                        default
                        for default in statement.args.kw_defaults
                        if default is not None
                    ),
                    *(
                        ()
                        if future_annotations[current_module]
                        else function_annotation_expressions(statement)
                    ),
                ):
                    queue_calls(expression, environment, current_module)
                environment[statement.name] = node_bindings.get(
                    id(statement),
                    ("function", current_module, statement),
                )
            elif isinstance(statement, ast.ClassDef):
                for expression in (
                    *statement.decorator_list,
                    *statement.bases,
                    *(keyword.value for keyword in statement.keywords),
                ):
                    queue_calls(expression, environment, current_module)
                environment[statement.name] = node_bindings.get(
                    id(statement),
                    ("class", current_module, statement.name, statement),
                )
                class_environment = dict(environment)
                process_statements(
                    [
                        member
                        for member in statement.body
                        if not isinstance(
                            member,
                            (ast.FunctionDef, ast.AsyncFunctionDef),
                        )
                    ],
                    class_environment,
                    current_module,
                    root=root,
                )
            elif isinstance(statement, ast.Assign):
                queue_calls(statement.value, environment, current_module)
                value = resolve_expression(
                    statement.value,
                    environment,
                    current_module,
                )
                for target in statement.targets:
                    bind_target(target, value, environment, current_module)
            elif isinstance(statement, ast.AnnAssign):
                if statement.value is not None:
                    queue_calls(statement.value, environment, current_module)
                    value = resolve_expression(
                        statement.value,
                        environment,
                        current_module,
                    )
                else:
                    value = ("unknown",)
                bind_target(statement.target, value, environment, current_module)
            elif isinstance(statement, ast.Delete):
                for target in statement.targets:
                    delete_target(target, environment, current_module)
            elif isinstance(statement, (ast.Expr, ast.Return, ast.Raise)):
                value = (
                    statement.value
                    if isinstance(statement, (ast.Expr, ast.Return))
                    else statement.exc
                )
                if value is not None:
                    queue_calls(value, environment, current_module)
                if isinstance(statement, (ast.Return, ast.Raise)):
                    return True
            elif isinstance(statement, ast.If):
                queue_calls(statement.test, environment, current_module)
                condition = static_truth(statement.test, root=root)
                if condition is True:
                    if process_statements(
                        statement.body,
                        environment,
                        current_module,
                        root=root,
                    ):
                        return True
                elif condition is False:
                    if process_statements(
                        statement.orelse,
                        environment,
                        current_module,
                        root=root,
                    ):
                        return True
                else:
                    left = dict(environment)
                    right = dict(environment)
                    left_terminated = process_statements(
                        statement.body,
                        left,
                        current_module,
                        root=root,
                    )
                    right_terminated = process_statements(
                        statement.orelse,
                        right,
                        current_module,
                        root=root,
                    )
                    for name in set(left) | set(right):
                        if left.get(name) == right.get(name):
                            environment[name] = left[name]
                        else:
                            environment[name] = ("unknown",)
                    if left_terminated and right_terminated:
                        return True
            elif isinstance(statement, ast.AsyncFor):
                queue_calls(statement.iter, environment, current_module)
                iterable = resolve_expression(
                    statement.iter,
                    environment,
                    current_module,
                )
                if iterable[0] != "async-iterable":
                    return True
                queued_functions.append(
                    (
                        iterable[1],
                        not loop_body_may_resume(statement.body),
                    )
                )
                generator_node = iterable[1][2]
                (
                    may_yield,
                    may_exhaust_before_yield,
                    may_exhaust_after_yield,
                ) = (
                    async_generator_behavior(generator_node)
                    if isinstance(generator_node, ast.AsyncFunctionDef)
                    else (True, True, True)
                )
                branches: list[tuple[dict[str, tuple[Any, ...]], bool]] = []
                if may_exhaust_before_yield:
                    zero = dict(environment)
                    zero_terminated = process_statements(
                        statement.orelse,
                        zero,
                        current_module,
                        root=root,
                    )
                    branches.append((zero, zero_terminated))
                if may_yield:
                    many = dict(environment)
                    bind_target(
                        statement.target,
                        ("unknown",),
                        many,
                        current_module,
                    )
                    many_terminated = process_statements(
                        statement.body,
                        many,
                        current_module,
                        root=root,
                    )
                    if many_terminated:
                        branches.append(
                            (
                                many,
                                not statements_may_break_loop(statement.body),
                            )
                        )
                    elif may_exhaust_after_yield:
                        many_terminated = process_statements(
                            statement.orelse,
                            many,
                            current_module,
                            root=root,
                        )
                        branches.append((many, many_terminated))
                continuing = [
                    branch for branch, terminated in branches if not terminated
                ]
                if not continuing:
                    return True
                for name in set(environment).union(
                    *(set(branch) for branch in continuing)
                ):
                    values = [
                        branch.get(name, environment.get(name, ("unknown",)))
                        for branch in continuing
                    ]
                    environment[name] = (
                        values[0]
                        if all(value == values[0] for value in values[1:])
                        else ("unknown",)
                    )
            elif isinstance(statement, ast.For):
                queue_calls(statement.iter, environment, current_module)
                cardinality = static_iterable_cardinality(
                    statement.iter,
                    builtin_available=lambda name: name not in environment,
                )
                if cardinality == 0:
                    if process_statements(
                        statement.orelse,
                        environment,
                        current_module,
                        root=root,
                    ):
                        return True
                    continue
                if cardinality is not None:
                    nested = dict(environment)
                    bind_target(
                        statement.target,
                        ("unknown",),
                        nested,
                        current_module,
                    )
                    terminated = process_statements(
                        statement.body,
                        nested,
                        current_module,
                        root=root,
                    )
                    if not terminated:
                        process_statements(
                            statement.orelse,
                            nested,
                            current_module,
                            root=root,
                        )
                    environment.update(nested)
                    continue

                zero = dict(environment)
                zero_terminated = process_statements(
                    statement.orelse,
                    zero,
                    current_module,
                    root=root,
                )
                many = dict(environment)
                bind_target(
                    statement.target,
                    ("unknown",),
                    many,
                    current_module,
                )
                many_terminated = process_statements(
                    statement.body,
                    many,
                    current_module,
                    root=root,
                )
                if not many_terminated:
                    many_terminated = process_statements(
                        statement.orelse,
                        many,
                        current_module,
                        root=root,
                    )
                continuing = [
                    branch
                    for branch, terminated in (
                        (zero, zero_terminated),
                        (many, many_terminated),
                    )
                    if not terminated
                ]
                if not continuing:
                    return True
                for name in set(environment).union(
                    *(set(branch) for branch in continuing)
                ):
                    values = [
                        branch.get(name, environment.get(name, ("unknown",)))
                        for branch in continuing
                    ]
                    environment[name] = (
                        values[0]
                        if all(value == values[0] for value in values[1:])
                        else ("unknown",)
                    )
            elif isinstance(statement, ast.While):
                queue_calls(statement.test, environment, current_module)
                condition = static_truth(statement.test, root=root)
                if condition is not False:
                    process_statements(
                        statement.body,
                        environment,
                        current_module,
                        root=root,
                    )
                process_statements(
                    statement.orelse,
                    environment,
                    current_module,
                    root=root,
                )
            elif isinstance(statement, (ast.With, ast.AsyncWith)):
                for item in statement.items:
                    queue_calls(item.context_expr, environment, current_module)
                    if item.optional_vars is not None:
                        bind_target(
                            item.optional_vars,
                            resolve_expression(
                                item.context_expr,
                                environment,
                                current_module,
                            ),
                            environment,
                            current_module,
                        )
                if process_statements(
                    statement.body,
                    environment,
                    current_module,
                    root=root,
                ):
                    return True
            elif isinstance(statement, (ast.Try, ast.TryStar)):
                initial = dict(environment)
                branches: list[tuple[dict[str, tuple[Any, ...]], bool]] = []

                normal = dict(initial)
                normal_terminated = process_statements(
                    statement.body,
                    normal,
                    current_module,
                    root=root,
                )
                if not normal_terminated:
                    normal_terminated = process_statements(
                        statement.orelse,
                        normal,
                        current_module,
                        root=root,
                    )
                branches.append((normal, normal_terminated))

                for handler in statement.handlers:
                    handled = dict(initial)
                    if handler.name:
                        handled[handler.name] = ("unknown",)
                    handler_terminated = process_statements(
                        handler.body,
                        handled,
                        current_module,
                        root=root,
                    )
                    branches.append((handled, handler_terminated))

                finalized: list[tuple[dict[str, tuple[Any, ...]], bool]] = []
                for branch_environment, terminated in branches:
                    final_terminated = process_statements(
                        statement.finalbody,
                        branch_environment,
                        current_module,
                        root=root,
                    )
                    finalized.append(
                        (branch_environment, terminated or final_terminated)
                    )

                continuing = [
                    branch_environment
                    for branch_environment, terminated in finalized
                    if not terminated
                ]
                if not continuing:
                    return True
                for name in set(initial).union(
                    *(set(branch_environment) for branch_environment in continuing)
                ):
                    values = [
                        branch_environment.get(name, initial.get(name, ("unknown",)))
                        for branch_environment in continuing
                    ]
                    environment[name] = (
                        values[0]
                        if all(value == values[0] for value in values[1:])
                        else ("unknown",)
                    )
            elif isinstance(statement, ast.Match):
                queue_calls(statement.subject, environment, current_module)
                subject_value = resolve_expression(
                    statement.subject,
                    environment,
                    current_module,
                )
                subject = (
                    subject_value[1]
                    if subject_value[0] == "literal"
                    else _UNKNOWN_LITERAL
                )
                branches: list[dict[str, tuple[Any, ...]]] = []
                exhaustive = False
                for case in statement.cases:
                    matches = static_match_pattern(case.pattern, subject)
                    if matches is False:
                        continue
                    branch_environment = dict(environment)
                    for name in match_bound_names(case.pattern):
                        branch_environment[name] = ("unknown",)
                    guard = None
                    if case.guard is not None:
                        queue_calls(case.guard, branch_environment, current_module)
                        guard = static_truth(case.guard, root=root)
                        if guard is False:
                            continue
                    process_statements(
                        case.body,
                        branch_environment,
                        current_module,
                        root=root,
                    )
                    branches.append(branch_environment)
                    if matches is True and guard is not None:
                        exhaustive = guard is True
                    elif matches is True and case.guard is None:
                        exhaustive = True
                    if exhaustive:
                        break
                if not exhaustive:
                    branches.append(dict(environment))
                if branches:
                    for name in set(environment).union(
                        *(set(branch) for branch in branches)
                    ):
                        values = [
                            branch.get(name, environment.get(name, ("unknown",)))
                            for branch in branches
                        ]
                        environment[name] = (
                            values[0]
                            if all(value == values[0] for value in values[1:])
                            else ("unknown",)
                        )
            elif isinstance(statement, (ast.Break, ast.Continue)):
                return True
        return False

    while queued_modules or queued_functions:
        if queued_modules:
            name, root = queued_modules.pop(0)
            key = (name, root)
            if key in processed_modules:
                continue
            processed_modules.add(key)
            tree = modules[name][2]
            if tree is None:
                continue
            environment = module_environments[name]
            process_statements(tree.body, environment, name, root=root)
            continue

        binding, stop_at_first_yield = queued_functions.pop(0)
        node = binding[2]
        processing_key = (id(node), stop_at_first_yield)
        if processing_key in processed_functions:
            continue
        processed_functions.add(processing_key)
        current_module = str(binding[1])
        environment = dict(module_environments[current_module])
        active_global_names, _ = function_scope_declarations(node)
        if len(binding) > 3:
            environment["self"] = (
                "instance",
                current_module,
                str(binding[3]),
            )
        for name in function_local_bindings(node):
            environment[name] = ("unknown",)
        for parameter in [
            *node.args.posonlyargs,
            *node.args.args,
            *node.args.kwonlyargs,
        ]:
            environment[parameter.arg] = ("unknown",)
        if node.args.vararg is not None:
            environment[node.args.vararg.arg] = ("unknown",)
        if node.args.kwarg is not None:
            environment[node.args.kwarg.arg] = ("unknown",)
        suspend_on_yield = stop_at_first_yield
        process_statements(node.body, environment, current_module, root=False)
        suspend_on_yield = False
        active_global_names = set()

    return sorted(modules[name][0] for name in connected if name in modules)


PACKAGE_NAME = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?")
REQUIREMENT = re.compile(
    rf"^(?P<name>{PACKAGE_NAME.pattern})"
    r"(?P<extras>\s*\[[^\]]+\])?"
    r"(?P<constraint>[\s\S]*)$"
)
VERSION_CLAUSE = re.compile(r"(?:===|==|~=|!=|<=|>=|<|>)\s*[^,\s;]+")
MARKER_TOKEN = re.compile(
    r"\s*(?:"
    r"(?P<logic>and|or)\b|"
    r"(?P<operator>not\s+in|in|===|==|!=|<=|>=|<|>)|"
    r"(?P<paren>[()])|"
    r"(?P<string>\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*')|"
    r"(?P<variable>[A-Za-z_][A-Za-z0-9_.]*)"
    r")"
)


def normalized_package(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def valid_extras(extras: str | None) -> bool:
    if extras is None:
        return True
    content = extras.strip()[1:-1]
    return bool(content) and all(
        PACKAGE_NAME.fullmatch(item.strip()) for item in content.split(",")
    )


def marker_tokens(marker: str) -> list[tuple[str, str]] | None:
    tokens: list[tuple[str, str]] = []
    position = 0
    while position < len(marker):
        match = MARKER_TOKEN.match(marker, position)
        if not match:
            return None
        kind = match.lastgroup
        if kind is None:
            return None
        tokens.append((kind, match.group(kind)))
        position = match.end()
    return tokens


def valid_environment_marker(marker: str) -> bool:
    tokens = marker_tokens(marker.strip())
    if not tokens:
        return False
    position = 0

    def parse_operand() -> bool:
        nonlocal position
        if position >= len(tokens) or tokens[position][0] not in {
            "string",
            "variable",
        }:
            return False
        position += 1
        return True

    def parse_comparison() -> bool:
        nonlocal position
        if not parse_operand():
            return False
        if position >= len(tokens) or tokens[position][0] != "operator":
            return False
        position += 1
        return parse_operand()

    def parse_factor() -> bool:
        nonlocal position
        if position < len(tokens) and tokens[position] == ("paren", "("):
            position += 1
            if not parse_or():
                return False
            if position >= len(tokens) or tokens[position] != ("paren", ")"):
                return False
            position += 1
            return True
        return parse_comparison()

    def parse_and() -> bool:
        nonlocal position
        if not parse_factor():
            return False
        while position < len(tokens) and tokens[position] == ("logic", "and"):
            position += 1
            if not parse_factor():
                return False
        return True

    def parse_or() -> bool:
        nonlocal position
        if not parse_and():
            return False
        while position < len(tokens) and tokens[position] == ("logic", "or"):
            position += 1
            if not parse_and():
                return False
        return True

    return parse_or() and position == len(tokens)


def requirement_package(declaration: str) -> str | None:
    value = declaration.strip()
    match = REQUIREMENT.fullmatch(value)
    if not match or not valid_extras(match.group("extras")):
        return None

    constraint = match.group("constraint").strip()
    requirement_part, separator, marker = constraint.partition(";")
    if separator and not valid_environment_marker(marker):
        return None

    requirement_part = requirement_part.strip()
    if requirement_part:
        if requirement_part.startswith("@"):
            if not re.fullmatch(r"@\s*\S+", requirement_part):
                return None
        else:
            clauses = [item.strip() for item in requirement_part.split(",")]
            if not clauses or not all(
                VERSION_CLAUSE.fullmatch(item) for item in clauses
            ):
                return None

    return normalized_package(match.group("name"))


def valid_poetry_constraint(value: Any) -> bool:
    if isinstance(value, str):
        constraint = value.strip()
        if constraint == "*":
            return True
        alternatives = [item.strip() for item in constraint.split("||")]
        if not alternatives or any(not item for item in alternatives):
            return False
        token = re.compile(
            r"(?:\^|~)?[0-9][A-Za-z0-9.*+!_-]*"
            r"|(?:===|==|~=|!=|<=|>=|<|>)\s*[^,\s]+"
        )
        return all(
            all(token.fullmatch(part) for part in re.split(r"\s*,\s*|\s+", item))
            for item in alternatives
        )
    if isinstance(value, dict):
        if value.get("optional") is True:
            return False
        if "markers" in value and (
            not isinstance(value["markers"], str)
            or not valid_environment_marker(value["markers"])
        ):
            return False
        for key in ("version", "url", "git", "path"):
            if key not in value:
                continue
            dependency = value[key]
            if key == "version":
                return valid_poetry_constraint(dependency)
            return isinstance(dependency, str) and bool(dependency.strip())
    return False


def runtime_manifest(filename: str) -> bool:
    name = PurePosixPath(filename.replace("\\", "/")).name.lower()
    if name in {"pyproject.toml", "setup.py"}:
        return True
    return bool(
        re.fullmatch(
            r"requirements(?:[._-](?!dev|test|lint|docs)[a-z0-9_-]+)?\.txt", name
        )
    )


def dependency_values(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        dependencies: list[str] = []
        for item in value:
            dependencies.extend(dependency_values(item))
        return dependencies
    return []


def packages_from_pyproject(content: str) -> set[str]:
    try:
        document = tomllib.loads(content)
    except tomllib.TOMLDecodeError:
        return set()

    packages: set[str] = set()

    def add_declarations(value: Any) -> None:
        for declaration in dependency_values(value):
            package = requirement_package(declaration)
            if package:
                packages.add(package)

    project = document.get("project")
    if isinstance(project, dict):
        add_declarations(project.get("dependencies"))

    tool = document.get("tool")
    if not isinstance(tool, dict):
        return packages

    poetry = tool.get("poetry")
    if isinstance(poetry, dict):
        sections = [poetry.get("dependencies")]
        groups = poetry.get("group")
        if isinstance(groups, dict):
            main_group = groups.get("main")
            if isinstance(main_group, dict):
                sections.append(main_group.get("dependencies"))
        for section in sections:
            if not isinstance(section, dict):
                continue
            for declaration, constraint in section.items():
                if (
                    normalized_package(declaration) == "python"
                    or not PACKAGE_NAME.fullmatch(declaration)
                    or not valid_poetry_constraint(constraint)
                ):
                    continue
                packages.add(normalized_package(declaration))

    pdm = tool.get("pdm")
    if isinstance(pdm, dict):
        dependencies = pdm.get("dependencies")
        if isinstance(dependencies, dict):
            for declaration, constraint in dependencies.items():
                if not PACKAGE_NAME.fullmatch(
                    declaration
                ) or not valid_poetry_constraint(constraint):
                    continue
                packages.add(normalized_package(declaration))
        else:
            add_declarations(dependencies)

    return packages


def packages_from_setup_py(content: str) -> set[str]:
    try:
        tree = ast.parse(content, filename="setup.py")
    except SyntaxError:
        return set()

    assignments: dict[str, ast.expr] = {}
    setup_names: set[str] = set()
    setuptools_modules: set[str] = set()
    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    assignments[target.id] = statement.value
        elif (
            isinstance(statement, ast.AnnAssign)
            and isinstance(statement.target, ast.Name)
            and statement.value is not None
        ):
            assignments[statement.target.id] = statement.value
        elif isinstance(statement, ast.Import):
            for alias in statement.names:
                if alias.name in {"setuptools", "distutils.core"}:
                    setuptools_modules.add(alias.asname or alias.name)
        elif isinstance(statement, ast.ImportFrom) and statement.module in {
            "setuptools",
            "distutils.core",
        }:
            for alias in statement.names:
                if alias.name == "setup":
                    setup_names.add(alias.asname or alias.name)

    def sequence(node: ast.expr, seen: frozenset[str] = frozenset()) -> list[str]:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return [node.value]
        if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            values: list[str] = []
            for item in node.elts:
                values.extend(sequence(item, seen))
            return values
        if isinstance(node, ast.Starred):
            return sequence(node.value, seen)
        if (
            isinstance(node, ast.Name)
            and node.id in assignments
            and node.id not in seen
        ):
            return sequence(assignments[node.id], seen | {node.id})
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return sequence(node.left, seen) + sequence(node.right, seen)
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"list", "tuple", "set"}
            and len(node.args) == 1
        ):
            return sequence(node.args[0], seen)
        return []

    def mapping(
        node: ast.expr, seen: frozenset[str] = frozenset()
    ) -> dict[str, ast.expr]:
        if isinstance(node, ast.Dict):
            return {
                key.value: value
                for key, value in zip(node.keys, node.values)
                if isinstance(key, ast.Constant) and isinstance(key.value, str)
            }
        if (
            isinstance(node, ast.Name)
            and node.id in assignments
            and node.id not in seen
        ):
            return mapping(assignments[node.id], seen | {node.id})
        return {}

    def is_setup_call(node: ast.Call) -> bool:
        if isinstance(node.func, ast.Name):
            return node.func.id in setup_names
        return (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "setup"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id in setuptools_modules
        )

    packages: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not is_setup_call(node):
            continue
        dependency_nodes: list[ast.expr] = []
        for keyword in node.keywords:
            if keyword.arg == "install_requires":
                dependency_nodes.append(keyword.value)
            elif keyword.arg is None:
                install_requires = mapping(keyword.value).get("install_requires")
                if install_requires is not None:
                    dependency_nodes.append(install_requires)
        for dependency_node in dependency_nodes:
            for declaration in sequence(dependency_node):
                package = requirement_package(declaration)
                if package:
                    packages.add(package)
    return packages


def packages_from_manifests(manifests: list[dict[str, str]]) -> set[str]:
    packages: set[str] = set()
    for manifest in manifests:
        filename = str(manifest.get("filename", "requirements.txt"))
        content = str(manifest.get("content", ""))
        if not runtime_manifest(filename):
            continue
        name = PurePosixPath(filename.replace("\\", "/")).name.lower()
        if name.startswith("requirements"):
            for line in content.splitlines():
                stripped = re.sub(r"\s+#.*$", "", line).strip()
                if stripped and not stripped.startswith(
                    ("-", "http:", "https:", "git+")
                ):
                    package = requirement_package(stripped)
                    if package:
                        packages.add(package)
        elif name == "pyproject.toml":
            packages.update(packages_from_pyproject(content))
        else:
            packages.update(packages_from_setup_py(content))
    return packages


class Analyzer:
    def __init__(
        self,
        documents: list[dict[str, str]],
        application_roots: list[str],
    ) -> None:
        self.modules: dict[str, ModuleInfo] = {}
        self.dynamic_functions: dict[str, FunctionInfo] = {}
        self.valid = True
        self.operations: list[dict[str, Any]] = []
        self.executed: set[str] = set()
        self.stack: list[str] = []
        self.current_function: FunctionInfo | None = None
        self.generator_yield_counts: list[int] = []
        self.generator_replay_value_ids: list[set[int]] = []
        self.evaluating_yield_operand = 0
        self.replaying_generator_call = False
        self.resumed_generator_conditions: dict[int, dict[str, Any]] = {}
        self.async_continuations: dict[int, dict[str, Any]] = {}
        self.next_id = 1
        self.next_branch = 1
        self.path_constraints: dict[int, bool | str] = {}
        self.branch_contexts: dict[int, tuple[tuple[int, bool | str], ...]] = {}
        self.branch_choices: dict[int, set[bool | str]] = {}
        self.parsers: set[str] = set()
        self.manual_json_functions: set[str] = set()
        self.tainted_warning_roots: set[str] = set()
        self.warning_binding_cache: dict[str, tuple[dict[str, str], set[str]]] = {}
        self.try_handlers: dict[int, dict[str, Any]] = {}
        self.application_roots = {module_name(path) for path in application_roots}
        self._load(documents)

    def new_id(self) -> int:
        value = self.next_id
        self.next_id += 1
        return value

    def record(self, kind: str, **values: Any) -> None:
        self.operations.append(
            {
                "kind": kind,
                "sequence": len(self.operations),
                "path": tuple(sorted(self.path_constraints.items())),
                "stack": tuple(self.stack),
                "function": self.current_function.key
                if self.current_function
                else "<module>",
                "async": bool(self.current_function and self.current_function.is_async),
                **values,
            }
        )

    def external_state_snapshot(
        self,
        extra_values: Any = (),
    ) -> dict[str, Any]:
        closures = {
            key: dict(function.closure)
            for key, function in self.dynamic_functions.items()
            if function.closure is not None
        }
        roots = [
            *(
                value
                for module in self.modules.values()
                for value in module.env.values()
            ),
            *(value for closure in closures.values() for value in closure.values()),
            *extra_values,
        ]
        sequences: dict[int, tuple[Value, tuple[Value, ...]]] = {}
        mappings: dict[int, tuple[Value, dict[Any, Value]]] = {}
        attributes: dict[int, tuple[Value, dict[str, Value]]] = {}
        seen: set[int] = set()

        def collect(value: Any) -> None:
            if not isinstance(value, Value) or id(value) in seen:
                return
            seen.add(id(value))
            if value.kind in {"list", "set"}:
                sequences[id(value)] = (value, value.items)
            if value.kind == "dict" and isinstance(value.data, dict):
                mappings[id(value)] = (value, dict(value.data))
            attributes[id(value)] = (value, dict(value.attrs))
            for item in value.items:
                collect(item)
            for item in value.attrs.values():
                collect(item)
            if isinstance(value.data, dict):
                for item in value.data.values():
                    collect(item)

        for value in roots:
            collect(value)
        return {
            "modules": {
                name: dict(module.env) for name, module in self.modules.items()
            },
            "closures": closures,
            "sequences": sequences,
            "mappings": mappings,
            "attributes": attributes,
        }

    def restore_external_state(self, snapshot: dict[str, Any]) -> None:
        for name, values in snapshot["modules"].items():
            self.modules[name].env.clear()
            self.modules[name].env.update(values)
        for key, values in snapshot["closures"].items():
            function = self.dynamic_functions.get(key)
            if function is not None and function.closure is not None:
                function.closure.clear()
                function.closure.update(values)
        for value, items in snapshot.get("sequences", {}).values():
            value.items = items
        for value, items in snapshot.get("mappings", {}).values():
            value.data.clear()
            value.data.update(items)
        for value, attributes in snapshot["attributes"].values():
            value.attrs.clear()
            value.attrs.update(attributes)

    def apply_external_state_delta(
        self,
        before: dict[str, Any],
        after: dict[str, Any],
    ) -> None:
        for name, after_values in after["modules"].items():
            current = self.modules[name].env
            before_values = before["modules"].get(name, {})
            for key in set(before_values) | set(after_values):
                if key not in after_values:
                    current.pop(key, None)
                elif (
                    key not in before_values
                    or before_values[key] is not after_values[key]
                ):
                    current[key] = after_values[key]
        for key, after_values in after["closures"].items():
            function = self.dynamic_functions.get(key)
            if function is None or function.closure is None:
                continue
            current = function.closure
            before_values = before["closures"].get(key, {})
            for name in set(before_values) | set(after_values):
                if name not in after_values:
                    current.pop(name, None)
                elif (
                    name not in before_values
                    or before_values[name] is not after_values[name]
                ):
                    current[name] = after_values[name]
        before_sequences = before.get("sequences", {})
        for identity, (value, after_items) in after.get("sequences", {}).items():
            before_items = before_sequences.get(identity, (value, ()))[1]
            if not same_value_sequence(before_items, after_items):
                value.items = after_items
        before_mappings = before.get("mappings", {})
        for identity, (value, after_items) in after.get("mappings", {}).items():
            before_items = before_mappings.get(identity, (value, {}))[1]
            if not same_value_mapping(before_items, after_items):
                value.data.clear()
                value.data.update(after_items)
        before_attributes = before["attributes"]
        for identity, (value, after_values) in after["attributes"].items():
            before_values = before_attributes.get(identity, (value, {}))[1]
            for name in set(before_values) | set(after_values):
                if name not in after_values:
                    value.attrs.pop(name, None)
                elif (
                    name not in before_values
                    or before_values[name] is not after_values[name]
                ):
                    value.attrs[name] = after_values[name]

    @staticmethod
    def clone_async_continuations(
        continuations: dict[int, dict[str, Any]],
    ) -> dict[int, dict[str, Any]]:
        return {
            key: {
                **state,
                "committed_operations": set(state["committed_operations"]),
                "operation_locations": dict(state["operation_locations"]),
            }
            for key, state in continuations.items()
        }

    def current_exec_outcome(
        self,
        control: str,
        environment: dict[str, Value],
        value: Value | None = None,
        *,
        path: tuple[tuple[int, bool | str], ...] | None = None,
    ) -> ExecOutcome:
        return ExecOutcome(
            control=control,
            path=(
                tuple(sorted(self.path_constraints.items())) if path is None else path
            ),
            environment=dict(environment),
            value=value or Value(),
            external_state=self.external_state_snapshot(environment.values()),
            async_continuations=self.clone_async_continuations(
                self.async_continuations
            ),
        )

    def derived_exec_outcome(
        self,
        outcome: ExecOutcome,
        control: str,
        *,
        environment: dict[str, Value] | None = None,
        value: Value | None = None,
        external_state: dict[str, Any] | None = None,
    ) -> ExecOutcome:
        return ExecOutcome(
            control=control,
            path=outcome.path,
            environment=dict(
                outcome.environment if environment is None else environment
            ),
            value=outcome.value if value is None else value,
            external_state=(
                outcome.external_state if external_state is None else external_state
            ),
            async_continuations=self.clone_async_continuations(
                outcome.async_continuations
            ),
        )

    def activate_exec_outcome(self, outcome: ExecOutcome) -> None:
        if outcome.external_state is not None:
            self.restore_external_state(outcome.external_state)
        self.async_continuations = self.clone_async_continuations(
            outcome.async_continuations
        )

    def generator_consumer_outcome(
        self,
        outcome: ExecOutcome,
        iteration: AsyncIteration,
        control: str,
    ) -> ExecOutcome:
        external_state = outcome.external_state
        target = iteration.state.get("target")
        if (
            external_state is not None
            and isinstance(target, FunctionInfo)
            and target.closure is not None
        ):
            external_state = {
                **external_state,
                "closures": {
                    **external_state["closures"],
                    target.key: dict(outcome.environment),
                },
            }
        return self.derived_exec_outcome(
            outcome,
            control,
            external_state=external_state,
        )

    def _load(self, documents: list[dict[str, str]]) -> None:
        for document in documents:
            path = str(document.get("path", "application.py"))
            source = str(document.get("source", ""))
            name = module_name(path)
            try:
                tree = compile_module(source, path)
            except (SyntaxError, TypeError, ValueError):
                self.valid = False
                continue
            self.modules[name] = ModuleInfo(
                name=name,
                path=path,
                is_package=path.replace("\\", "/").endswith("/__init__.py"),
                tree=tree,
                postponed_annotations=postpones_annotations(tree),
            )

        if not self.valid:
            return

        for module in self.modules.values():
            for statement in module.tree.body:
                if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    function = FunctionInfo(
                        key=f"{module.name}:{statement.name}",
                        module=module.name,
                        node=statement,
                    )
                    module.functions[statement.name] = function
                elif isinstance(statement, ast.ClassDef):
                    methods: dict[str, FunctionInfo] = {}
                    fields: list[tuple[str, ast.expr | None]] = []
                    class_key = f"{module.name}:{statement.name}"
                    for member in statement.body:
                        if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            methods[member.name] = FunctionInfo(
                                key=f"{class_key}.{member.name}",
                                module=module.name,
                                node=member,
                                class_key=class_key,
                            )
                        elif isinstance(member, ast.AnnAssign) and isinstance(
                            member.target, ast.Name
                        ):
                            fields.append((member.target.id, member.value))
                    class_info = ClassInfo(
                        key=class_key,
                        module=module.name,
                        node=statement,
                        methods=methods,
                        fields=fields,
                        dataclass=any(
                            (dotted(decorator.func) if isinstance(decorator, ast.Call) else dotted(decorator))
                            in {"dataclass", "dataclasses.dataclass"}
                            for decorator in statement.decorator_list
                        ),
                    )
                    module.classes[statement.name] = class_info

        for _ in range(len(self.modules) + 2):
            for module in self.modules.values():
                environment = {"__name__": literal(module.name)}
                for statement in module.tree.body:
                    self.bind_statement(statement, environment, module)
                module.env = environment

        self.operations.clear()
        self.executed.clear()
        self.stack.clear()
        self.current_function = None
        self.next_id = 1
        self.next_branch = 1
        self.try_handlers.clear()

        for module in self.modules.values():
            for function in module.functions.values():
                if self.is_subject_parser(function):
                    self.parsers.add(function.key)
            for class_info in module.classes.values():
                for function in class_info.methods.values():
                    if self.is_subject_parser(function):
                        self.parsers.add(function.key)
        self.tainted_warning_roots = self.warning_api_mutations()

    def local_sdk_shadow(self, imported_module: str) -> bool:
        if imported_module != "azure" and not imported_module.startswith("azure."):
            return False
        return any(
            imported_module == local_module
            or imported_module.startswith(f"{local_module}.")
            for local_module in self.modules
            if local_module == "azure" or local_module.startswith("azure.")
        )

    def local_import_shadow(self, imported_module: str) -> bool:
        if self.local_sdk_shadow(imported_module):
            return True
        root = imported_module.split(".", 1)[0]
        if root not in {"logging", "sys", "warnings"}:
            return False
        return any(
            local_module == root or local_module.startswith(f"{root}.")
            for local_module in self.modules
        )

    def absolute_import_name(
        self,
        module: ModuleInfo,
        imported_module: str | None,
        level: int,
    ) -> str:
        if level == 0:
            return imported_module or ""
        package = module.name.split(".")
        if not module.is_package:
            package = package[:-1]
        trim = max(0, level - 1)
        if trim:
            package = package[: max(0, len(package) - trim)]
        if imported_module:
            package.extend(imported_module.split("."))
        return ".".join(package)

    def imported_module_value(self, imported_module: str) -> Value:
        local_module = self.modules.get(imported_module)
        if local_module:
            return Value(kind="local-module", data=local_module)
        return Value(
            kind=(
                "local-shadow"
                if self.local_import_shadow(imported_module)
                else "module"
            ),
            data=imported_module,
        )

    def imported_symbol_value(
        self,
        imported_module: str,
        name: str,
    ) -> Value:
        local_module = self.modules.get(imported_module)
        if local_module:
            if name in local_module.env:
                return local_module.env[name]
            nested = self.modules.get(f"{imported_module}.{name}")
            if nested:
                return Value(kind="local-module", data=nested)
            return Value(kind="local-shadow", data=f"{imported_module}.{name}")
        if self.local_import_shadow(imported_module):
            return Value(kind="local-shadow", data=f"{imported_module}.{name}")
        return Value(kind="sdk", data=f"{imported_module}.{name}")

    def bind_statement(
        self,
        statement: ast.stmt,
        environment: dict[str, Value],
        module: ModuleInfo,
    ) -> None:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            value = module.functions.get(statement.name)
            if value is None and self.current_function is not None:
                key = (
                    f"{self.current_function.key}:<locals>."
                    f"{statement.name}@{statement.lineno}"
                )
                value = FunctionInfo(
                    key=key,
                    module=module.name,
                    node=statement,
                    closure=environment,
                    closure_names=frozenset(
                        function_local_bindings(self.current_function.node)
                    ),
                )
                self.dynamic_functions[key] = value
            environment[statement.name] = (
                Value(kind="function", data=value)
                if value is not None
                else Value(kind="local-shadow", data=statement.name)
            )
        elif isinstance(statement, ast.ClassDef):
            value = module.classes.get(statement.name)
            environment[statement.name] = (
                Value(kind="class", data=value)
                if value is not None
                else Value(kind="local-shadow", data=statement.name)
            )
        elif isinstance(statement, ast.Import):
            for alias in statement.names:
                bound = alias.asname or alias.name.split(".", 1)[0]
                imported = alias.name if alias.asname else alias.name.split(".", 1)[0]
                environment[bound] = self.imported_module_value(imported)
        elif isinstance(statement, ast.ImportFrom):
            imported_module = self.absolute_import_name(
                module,
                statement.module,
                statement.level,
            )
            for alias in statement.names:
                bound = alias.asname or alias.name
                environment[bound] = self.imported_symbol_value(
                    imported_module,
                    alias.name,
                )
        elif isinstance(statement, ast.Assign):
            value = self.eval_expr(statement.value, dict(environment), module)
            for target in statement.targets:
                self.assign(target, value, environment, module)
        elif isinstance(statement, ast.AnnAssign) and statement.value:
            value = self.eval_expr(statement.value, dict(environment), module)
            self.assign(statement.target, value, environment, module)

    def warning_api_mutations(self) -> set[str]:
        tainted: set[str] = set()
        function_keys = {
            id(function.node): function.key
            for module in self.modules.values()
            for function in (
                *module.functions.values(),
                *(
                    method
                    for class_info in module.classes.values()
                    for method in class_info.methods.values()
                ),
            )
        }
        function_keys.update(
            (id(function.node), function.key)
            for function in self.dynamic_functions.values()
        )

        for module in self.modules.values():
            aliases = {
                name: str(value.data).split(".", 1)[0]
                for name, value in module.env.items()
                if value.kind in {"module", "sdk"}
                and str(value.data).split(".", 1)[0] in TRUSTED_WARNING_ROOTS
            }

            class MutationVisitor(ast.NodeVisitor):
                def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
                    self.visit_function(node)

                def visit_AsyncFunctionDef(
                    self,
                    node: ast.AsyncFunctionDef,
                ) -> None:
                    self.visit_function(node)

                def visit_function(
                    self,
                    node: ast.FunctionDef | ast.AsyncFunctionDef,
                ) -> None:
                    for expression in (
                        *node.decorator_list,
                        *node.args.defaults,
                        *(
                            default
                            for default in node.args.kw_defaults
                            if default is not None
                        ),
                        *(
                            ()
                            if module.postponed_annotations
                            else function_annotation_expressions(node)
                        ),
                    ):
                        self.visit(expression)
                    if function_keys.get(id(node)) in self_analyzer.executed:
                        for statement in node.body:
                            self.visit(statement)

                def visit_Lambda(self, node: ast.Lambda) -> None:
                    return

                def visit_ClassDef(self, node: ast.ClassDef) -> None:
                    for expression in (
                        *node.decorator_list,
                        *node.bases,
                        *(keyword.value for keyword in node.keywords),
                    ):
                        self.visit(expression)
                    for statement in node.body:
                        self.visit(statement)

                def visit_Assign(self, node: ast.Assign) -> None:
                    inspect_targets(node.targets)
                    self.generic_visit(node)

                def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
                    inspect_targets([node.target])
                    self.generic_visit(node)

                def visit_AugAssign(self, node: ast.AugAssign) -> None:
                    inspect_targets([node.target])
                    self.generic_visit(node)

                def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
                    inspect_targets([node.target])
                    self.generic_visit(node)

                def visit_Delete(self, node: ast.Delete) -> None:
                    inspect_targets(node.targets)
                    self.generic_visit(node)

            def inspect_targets(targets: list[ast.expr]) -> None:
                for target in targets:
                    if not isinstance(target, ast.Attribute):
                        continue
                    path = dotted(target)
                    if not path:
                        continue
                    root_name = path.split(".", 1)[0]
                    root = aliases.get(root_name)
                    if root:
                        tainted.add(root)

            self_analyzer = self
            MutationVisitor().visit(module.tree)
        return tainted

    def branch_id(self) -> int:
        branch = self.next_branch
        self.next_branch += 1
        self.branch_contexts[branch] = tuple(sorted(self.path_constraints.items()))
        self.branch_choices[branch] = set()
        return branch

    def constrain_path(self, branch: int, choice: bool | str) -> None:
        self.path_constraints[branch] = choice
        self.branch_choices.setdefault(branch, set()).add(choice)

    def execute(self) -> None:
        if not self.valid:
            return
        for module in self.modules.values():
            environment = {
                "__name__": literal(
                    "__main__" if module.name in self.application_roots else module.name
                )
            }
            self.exec_statements(module.tree.body, environment, module)

    @staticmethod
    def is_main_guard(test: ast.expr) -> bool:
        if (
            not isinstance(test, ast.Compare)
            or len(test.ops) != 1
            or len(test.comparators) != 1
            or not isinstance(test.ops[0], (ast.Eq, ast.Is))
        ):
            return False
        left, right = test.left, test.comparators[0]
        return (
            isinstance(left, ast.Name)
            and left.id == "__name__"
            and isinstance(right, ast.Constant)
            and right.value == "__main__"
        ) or (
            isinstance(right, ast.Name)
            and right.id == "__name__"
            and isinstance(left, ast.Constant)
            and left.value == "__main__"
        )

    def resolve_name(
        self, name: str, environment: dict[str, Value], module: ModuleInfo
    ) -> Value:
        if self.current_function is not None:
            globals_, nonlocals = function_scope_declarations(
                self.current_function.node
            )
            if name in globals_:
                return module.env.get(name, Value(kind="builtin", data=name))
            if name in nonlocals and self.current_function.closure is not None:
                return self.current_function.closure.get(
                    name,
                    Value(kind="builtin", data=name),
                )
        if name in environment:
            return environment[name]
        if name in module.env:
            return module.env[name]
        return Value(kind="builtin", data=name)

    def attribute(self, value: Value, name: str) -> Value:
        if value.kind == "local-module":
            module: ModuleInfo = value.data
            if name in module.env:
                return module.env[name]
            nested = self.modules.get(f"{module.name}.{name}")
            if nested:
                return Value(kind="local-module", data=nested)
            return Value(kind="local-shadow", data=f"{module.name}.{name}")
        if value.kind in {"module", "sdk"}:
            origin = f"{value.data}.{name}"
            system_event_names = {
                "azure.eventgrid.SystemEventNames.StorageBlobCreated": (
                    "Microsoft.Storage.BlobCreated"
                ),
                "azure.eventgrid.SystemEventNames.StorageBlobDeleted": (
                    "Microsoft.Storage.BlobDeleted"
                ),
            }
            if origin in system_event_names:
                return literal(system_event_names[origin])
            return Value(kind="sdk", data=origin)
        if value.kind == "instance":
            if name in value.attrs:
                return with_tags(value.attrs[name], value.tags)
            class_info: ClassInfo = value.data
            if name in class_info.methods:
                return Value(
                    kind="bound",
                    data=(class_info.methods[name], value),
                )
        if value.kind == "class":
            class_info: ClassInfo = value.data
            function = class_info.methods.get(name)
            if function is not None and any(
                dotted(decorator) in {"classmethod", "builtins.classmethod"}
                for decorator in function.node.decorator_list
            ):
                return Value(kind="bound", data=(function, value))
        if value.kind == "event":
            if name in {"event_type", "type"}:
                return Value(
                    kind="literal" if value.data.get("type") else "event-type",
                    data=value.data.get("type"),
                    tags=frozenset({f"event-type:{value.data['schema']}"}),
                )
            if name == "subject":
                return Value(
                    kind="literal" if value.data.get("subject") else "subject",
                    data=value.data.get("subject"),
                    tags=frozenset({"event-subject"}),
                )
            if name == "data":
                return Value(kind="event-data", tags=frozenset({"event-data"}))
            if name == "specversion":
                return literal(
                    "1.0" if value.data["schema"] == "cloud" else None
                )
        if value.kind == "properties":
            blob_id = value.data
            if name == "size":
                return Value(tags=frozenset({f"summary:size:{blob_id}"}))
            if name in {"blob_tier", "access_tier", "archive_status"}:
                return Value(tags=frozenset({f"summary:tier:{blob_id}"}))
            if name == "content_settings":
                return Value(kind="content-settings", data=blob_id)
        if value.kind == "content-settings" and name == "content_type":
            return Value(tags=frozenset({f"summary:content-type:{value.data}"}))
        if value.kind == "posix-path" and name == "parts":
            return Value(kind="tuple", items=value.items)
        if value.kind == "blob-name" and name in {"name", "path"}:
            return value
        if value.kind in {
            "blob-service",
            "container-client",
            "blob-client",
            "downloader",
            "publisher",
            "logger",
            "event-loop",
            "async-task-group",
            "task",
            "literal",
            "text",
            "list",
            "set",
            "tuple",
            "dict",
            "regex",
            "regex-match",
        }:
            return Value(kind="method", data=(value, name))
        return Value()

    def comprehension_environments(
        self,
        generators: list[ast.comprehension],
        environment: dict[str, Value],
        module: ModuleInfo,
        index: int = 0,
    ) -> list[dict[str, Value]]:
        if index >= len(generators):
            return [environment]
        generator = generators[index]
        iterable = self.eval_expr(generator.iter, environment, module)
        items = (
            iterable.items
            if iterable.kind in ITERABLE_VALUE_KINDS
            else (unknown(iterable),)
        )
        if iterable.tags:
            items = tuple(with_tags(item, iterable.tags) for item in items)
        results: list[dict[str, Value]] = []
        for item in items:
            nested = dict(environment)
            self.assign(generator.target, item, nested, module)
            possible = True
            for condition in generator.ifs:
                truth = self.eval_condition(condition, nested, module)
                if truth is False:
                    possible = False
                    break
            if possible:
                results.extend(
                    self.comprehension_environments(
                        generators,
                        nested,
                        module,
                        index + 1,
                    )
                )
        return results

    def eval_expr(
        self,
        node: ast.expr,
        environment: dict[str, Value],
        module: ModuleInfo,
        *,
        awaited: bool = False,
    ) -> Value:
        if isinstance(node, ast.Constant):
            return literal(node.value)
        if isinstance(node, ast.Name):
            return self.resolve_name(node.id, environment, module)
        if isinstance(node, ast.Attribute):
            return self.attribute(
                self.eval_expr(node.value, environment, module), node.attr
            )
        if isinstance(node, ast.List):
            items = tuple(
                self.eval_expr(item, environment, module) for item in node.elts
            )
            return Value(kind="list", items=items, tags=value_tags(Value(items=items)))
        if isinstance(node, ast.Tuple):
            items = tuple(
                self.eval_expr(item, environment, module) for item in node.elts
            )
            return Value(kind="tuple", items=items, tags=value_tags(Value(items=items)))
        if isinstance(node, ast.Set):
            items = tuple(
                self.eval_expr(item, environment, module) for item in node.elts
            )
            return Value(
                kind="set",
                items=unique_abstract_values(items),
                tags=value_tags(Value(items=items)),
            )
        if isinstance(node, ast.Dict):
            pairs: dict[Any, Value] = {}
            for key_node, value_node in zip(node.keys, node.values):
                key = (
                    self.eval_expr(key_node, environment, module)
                    if key_node
                    else Value()
                )
                value = self.eval_expr(value_node, environment, module)
                if key.kind == "literal":
                    pairs[key.data] = value
            tags: set[str] = set()
            for value in pairs.values():
                tags.update(value_tags(value))
            return Value(kind="dict", data=pairs, tags=frozenset(tags))
        if isinstance(node, (ast.ListComp, ast.SetComp)):
            items = tuple(
                self.eval_expr(node.elt, nested, module)
                for nested in self.comprehension_environments(
                    node.generators,
                    dict(environment),
                    module,
                )
            )
            return Value(
                kind="set" if isinstance(node, ast.SetComp) else "list",
                items=(
                    unique_abstract_values(items)
                    if isinstance(node, ast.SetComp)
                    else items
                ),
                tags=value_tags(Value(items=items)),
            )
        if isinstance(node, ast.DictComp):
            pairs: dict[Any, Value] = {}
            for nested in self.comprehension_environments(
                node.generators,
                dict(environment),
                module,
            ):
                key = self.eval_expr(node.key, nested, module)
                value = self.eval_expr(node.value, nested, module)
                if key.kind == "literal":
                    pairs[key.data] = value
            return Value(
                kind="dict",
                data=pairs,
                tags=value_tags(
                    Value(attrs={str(key): value for key, value in pairs.items()})
                ),
            )
        if isinstance(node, ast.JoinedStr):
            rendered: list[str] = []
            values: list[Value] = []
            can_render = True
            for item in node.values:
                if isinstance(item, ast.Constant) and isinstance(item.value, str):
                    rendered.append(item.value)
                    continue
                if not isinstance(item, ast.FormattedValue):
                    can_render = False
                    continue
                value = self.eval_expr(item.value, environment, module)
                values.append(value)
                if value.kind == "literal":
                    rendered.append(str(value.data))
                else:
                    can_render = False
            if not can_render:
                return Value(
                    kind="text",
                    data="".join(rendered),
                    tags=value_tags(unknown(*values)),
                )
            return Value(
                kind="literal",
                data="".join(rendered),
                tags=value_tags(unknown(*values)),
            )
        if isinstance(node, ast.FormattedValue):
            return self.eval_expr(node.value, environment, module)
        if isinstance(node, (ast.Yield, ast.YieldFrom)):
            self.evaluating_yield_operand += 1
            try:
                value = (
                    self.eval_expr(node.value, environment, module)
                    if node.value is not None
                    else Value()
                )
            finally:
                self.evaluating_yield_operand -= 1
            self.track_generator_replay_value(value)
            self.record(
                "yield",
                yielded=value,
                external_state=self.external_state_snapshot(environment.values()),
            )
            if self.generator_yield_counts:
                self.generator_yield_counts[-1] += 1
            return value
        if isinstance(node, ast.Await):
            value = self.eval_expr(node.value, environment, module, awaited=True)
            return self.await_value(value)
        if isinstance(node, ast.NamedExpr):
            value = self.eval_expr(node.value, environment, module)
            self.assign(node.target, value, environment, module)
            return value
        if isinstance(node, ast.IfExp):
            condition = self.eval_condition(node.test, environment, module)
            if condition is True:
                return self.eval_expr(node.body, environment, module)
            if condition is False:
                return self.eval_expr(node.orelse, environment, module)
            branch = self.branch_id()
            self.constrain_path(branch, True)
            left = self.eval_expr(node.body, dict(environment), module)
            self.constrain_path(branch, False)
            right = self.eval_expr(node.orelse, dict(environment), module)
            del self.path_constraints[branch]
            return unknown(left, right)
        if isinstance(node, ast.BoolOp):
            values: list[Value] = []
            uncertain = False
            for item in node.values:
                value = self.eval_expr(item, environment, module)
                values.append(value)
                truth = value_truth(value)
                if (
                    isinstance(node.op, ast.And)
                    and truth is False
                    and not uncertain
                ):
                    return value
                if (
                    isinstance(node.op, ast.Or)
                    and truth is True
                    and not uncertain
                ):
                    return value
                uncertain = uncertain or truth is None
            if values and all(value_truth(value) is not None for value in values[:-1]):
                return values[-1]
            return unknown(*values)
        if isinstance(node, ast.UnaryOp):
            value = self.eval_expr(node.operand, environment, module)
            truth = value_truth(value)
            if isinstance(node.op, ast.Not) and truth is not None:
                return literal(not truth)
            if value.kind == "literal" and isinstance(
                value.data,
                (int, float, complex),
            ):
                if isinstance(node.op, ast.UAdd):
                    return literal(+value.data)
                if isinstance(node.op, ast.USub):
                    return literal(-value.data)
                if isinstance(node.op, ast.Invert) and isinstance(value.data, int):
                    return literal(~value.data)
            return unknown(value)
        if isinstance(node, ast.BinOp):
            left = self.eval_expr(node.left, environment, module)
            right = self.eval_expr(node.right, environment, module)
            if (
                isinstance(node.op, ast.Add)
                and left.kind == "literal"
                and right.kind == "literal"
                and isinstance(left.data, (str, bytes, int, float))
                and isinstance(right.data, type(left.data))
            ):
                return literal(left.data + right.data)
            return unknown(left, right)
        if isinstance(node, ast.Subscript):
            base = self.eval_expr(node.value, environment, module)
            if isinstance(node.slice, ast.Slice) and base.kind in {"list", "tuple"}:
                lower = (
                    self.eval_expr(node.slice.lower, environment, module)
                    if node.slice.lower
                    else literal(None)
                )
                upper = (
                    self.eval_expr(node.slice.upper, environment, module)
                    if node.slice.upper
                    else literal(None)
                )
                step = (
                    self.eval_expr(node.slice.step, environment, module)
                    if node.slice.step
                    else literal(None)
                )
                if all(value.kind == "literal" for value in (lower, upper, step)):
                    try:
                        items = base.items[
                            slice(lower.data, upper.data, step.data)
                        ]
                    except (TypeError, ValueError):
                        return Value()
                    return Value(kind=base.kind, items=items)
                return Value()
            index = self.eval_expr(node.slice, environment, module)
            if base.kind in {"list", "tuple"} and index.kind == "literal":
                try:
                    selected = base.items[index.data]
                    if isinstance(index.data, slice):
                        return Value(kind=base.kind, items=selected)
                    return selected
                except (IndexError, TypeError, ValueError):
                    return Value()
            if base.kind == "dict" and index.kind == "literal":
                return base.data.get(index.data, Value())
            if (
                base.kind == "sdk"
                and base.data == "os.environ"
                and index.kind == "literal"
            ):
                return Value(kind="env", data=str(index.data))
            return Value()
        if isinstance(node, ast.Call):
            if self.defer_resumed_generator_call(node, environment):
                self.record(
                    "resumed-generator-call",
                    expression=node,
                    environment=dict(environment),
                    module=module.name,
                    external_state=self.external_state_snapshot(environment.values()),
                )
                return Value()
            function = self.eval_expr(node.func, environment, module)
            args = [self.eval_expr(arg, environment, module) for arg in node.args]
            kwargs = {
                keyword.arg: self.eval_expr(keyword.value, environment, module)
                for keyword in node.keywords
                if keyword.arg
            }
            return self.call(function, args, kwargs, module, awaited=awaited)
        if isinstance(node, ast.Compare):
            condition = self.eval_condition(node, environment, module)
            return literal(condition) if condition is not None else Value()
        return Value()

    def defer_resumed_generator_call(
        self,
        node: ast.Call,
        environment: dict[str, Value],
    ) -> bool:
        if (
            self.replaying_generator_call
            or self.evaluating_yield_operand > 0
            or self.current_function is None
            or not self.current_function.is_async_generator
            or not self.generator_yield_counts
            or self.generator_yield_counts[-1] == 0
        ):
            return False
        return self.resumed_generator_expression_uses_external(
            node.func,
            environment,
        )

    def resumed_generator_expression_uses_external(
        self,
        node: ast.AST,
        environment: dict[str, Value],
    ) -> bool:
        if (
            self.current_function is None
            or not self.current_function.is_async_generator
            or not self.generator_yield_counts
            or self.generator_yield_counts[-1] == 0
        ):
            return False
        local_names = function_local_bindings(self.current_function.node)
        globals_, nonlocals = function_scope_declarations(self.current_function.node)
        module = self.modules[self.current_function.module]
        return any(
            isinstance(child, ast.Name)
            and isinstance(child.ctx, ast.Load)
            and (
                child.id in globals_
                or child.id in nonlocals
                or child.id in self.current_function.closure_names
                or (child.id not in local_names and child.id in module.env)
                or self.generator_value_is_replay_dependent(environment.get(child.id))
            )
            for child in ast.walk(node)
        )

    @staticmethod
    def mutable_value_ids(value: Any) -> set[int]:
        identities: set[int] = set()
        seen: set[int] = set()

        def collect(current: Any) -> None:
            if not isinstance(current, Value) or id(current) in seen:
                return
            seen.add(id(current))
            if current.kind in MUTABLE_VALUE_KINDS or current.attrs:
                identities.add(id(current))
            for item in current.items:
                collect(item)
            for item in current.attrs.values():
                collect(item)
            if isinstance(current.data, dict):
                for item in current.data.values():
                    collect(item)

        collect(value)
        return identities

    def track_generator_replay_value(self, value: Any) -> None:
        if self.generator_replay_value_ids:
            self.generator_replay_value_ids[-1].update(self.mutable_value_ids(value))

    def generator_value_is_replay_dependent(
        self,
        value: Any,
    ) -> bool:
        return bool(
            self.generator_replay_value_ids
            and (self.mutable_value_ids(value) & self.generator_replay_value_ids[-1])
        )

    def resumed_generator_replay_environment(
        self,
        node: ast.AST,
        environment: dict[str, Value],
        module: ModuleInfo,
    ) -> dict[str, Value]:
        replay = dict(environment)
        if self.current_function is None:
            return replay
        local_names = function_local_bindings(self.current_function.node)
        globals_, nonlocals = function_scope_declarations(self.current_function.node)
        for child in ast.walk(node):
            if not isinstance(child, ast.Name) or not isinstance(child.ctx, ast.Load):
                continue
            name = child.id
            if name in nonlocals or name in self.current_function.closure_names:
                if (
                    self.current_function.closure is not None
                    and name in self.current_function.closure
                ):
                    replay[name] = self.current_function.closure[name]
            elif (name in globals_ or name not in local_names) and name in module.env:
                replay[name] = module.env[name]
        return replay

    def resumed_generator_path_matches(
        self,
        iteration: AsyncIteration,
        through: int | None,
    ) -> bool:
        choices = dict(iteration.path)
        for branch, choice in choices.items():
            condition = self.resumed_generator_conditions.get(branch)
            if condition is None:
                continue
            if through is not None and condition["position"] > through:
                continue
            saved_constraints = dict(self.path_constraints)
            previous_function = self.current_function
            previous_replaying = self.replaying_generator_call
            previous_stack = list(self.stack)
            try:
                self.path_constraints.clear()
                self.path_constraints.update(condition["path"])
                function = self.function(str(condition["function"]))
                self.current_function = function
                if function is not None:
                    self.stack.append(function.key)
                self.replaying_generator_call = True
                module = self.modules[str(condition["module"])]
                actual = self.eval_condition(
                    condition["expression"],
                    self.resumed_generator_replay_environment(
                        condition["expression"],
                        dict(condition["environment"]),
                        module,
                    ),
                    module,
                )
            finally:
                self.path_constraints.clear()
                self.path_constraints.update(saved_constraints)
                self.current_function = previous_function
                self.replaying_generator_call = previous_replaying
                self.stack[:] = previous_stack
            if actual is not None and actual != choice:
                return False
        return True

    def eval_condition(
        self, node: ast.expr, environment: dict[str, Value], module: ModuleInfo
    ) -> bool | None:
        static = static_literal_truth(node)
        if static is not None:
            return static
        if (
            isinstance(node, ast.Compare)
            and len(node.ops) == 1
            and len(node.comparators) == 1
        ):
            left = self.eval_expr(node.left, environment, module)
            right = self.eval_expr(node.comparators[0], environment, module)
            if left.kind == "literal" and right.kind == "literal":
                operator = node.ops[0]
                if isinstance(operator, (ast.Eq, ast.Is)):
                    return left.data == right.data
                if isinstance(operator, (ast.NotEq, ast.IsNot)):
                    return left.data != right.data
            return None
        if isinstance(node, ast.Name):
            value = self.resolve_name(node.id, environment, module)
            return value_truth(value)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            result = self.eval_condition(node.operand, environment, module)
            return None if result is None else not result
        if isinstance(node, ast.BoolOp):
            unknown_value = False
            for item in node.values:
                value = self.eval_condition(item, environment, module)
                if isinstance(node.op, ast.And) and value is False:
                    return False
                if isinstance(node.op, ast.Or) and value is True:
                    return True
                unknown_value = unknown_value or value is None
            if unknown_value:
                return None
            return isinstance(node.op, ast.And)
        if isinstance(node, ast.Call):
            value = self.eval_expr(node, environment, module)
            return value_truth(value)
        return value_truth(self.eval_expr(node, environment, module))

    def call(
        self,
        function: Value,
        args: list[Value],
        kwargs: dict[str, Value],
        module: ModuleInfo,
        *,
        awaited: bool,
    ) -> Value:
        if function.kind == "sdk":
            self.record("origin-call", origin=str(function.data))
        if function.kind == "function":
            target: FunctionInfo = function.data
            return self.dispatch_function_call(
                target,
                None,
                args,
                kwargs,
                awaited=awaited,
            )
        if function.kind == "bound":
            target, instance = function.data
            return self.dispatch_function_call(
                target,
                instance,
                args,
                kwargs,
                awaited=awaited,
            )
        if function.kind == "class":
            class_info: ClassInfo = function.data
            instance = Value(kind="instance", data=class_info)
            initializer = class_info.methods.get("__init__")
            if initializer:
                self.call_function(initializer, instance, args, kwargs)
            elif class_info.dataclass:
                class_module = self.modules[class_info.module]
                for index, (field_name, default) in enumerate(class_info.fields):
                    if field_name in kwargs:
                        instance.attrs[field_name] = kwargs[field_name]
                    elif index < len(args):
                        instance.attrs[field_name] = args[index]
                    elif default is not None:
                        instance.attrs[field_name] = self.eval_expr(
                            default,
                            dict(class_module.env),
                            class_module,
                        )
            return instance
        if function.kind == "builtin":
            if (
                function.data == "__import__"
                and args
                and args[0].kind == "literal"
                and isinstance(args[0].data, str)
            ):
                return self.imported_module_value(args[0].data)
            if function.data == "list":
                items = iterable_value_items(args[0]) if args else ()
                if items is not None:
                    return Value(
                        kind="list",
                        items=items,
                        tags=frozenset(
                            set(args[0].tags if args else ())
                            | set(value_tags(Value(items=items)))
                        ),
                    )
                return Value(
                    kind="list",
                    items=tuple(args),
                    tags=value_tags(Value(items=tuple(args))),
                )
            if function.data == "tuple":
                items = iterable_value_items(args[0]) if args else ()
                return Value(
                    kind="tuple",
                    items=items if items is not None else tuple(args),
                    tags=args[0].tags if args else frozenset(),
                )
            if function.data == "set":
                items = iterable_value_items(args[0]) if args else ()
                values = items if items is not None else tuple(args)
                return Value(
                    kind="set",
                    items=unique_abstract_values(values),
                    tags=frozenset(
                        set(args[0].tags if args else ())
                        | set(value_tags(Value(items=values)))
                    ),
                )
            if function.data == "dict":
                pairs: dict[Any, Value] = {}
                if args and args[0].kind == "dict":
                    pairs.update(args[0].data)
                pairs.update(kwargs)
                return Value(
                    kind="dict",
                    data=pairs,
                    tags=frozenset(
                        set(args[0].tags if args else ())
                        | set(
                            value_tags(
                                Value(
                                    attrs={
                                        str(key): value for key, value in pairs.items()
                                    }
                                )
                            )
                        )
                    ),
                )
            if (
                function.data == "slice"
                and not kwargs
                and 1 <= len(args) <= 3
                and all(value.kind == "literal" for value in args)
            ):
                try:
                    return literal(slice(*(value.data for value in args)))
                except TypeError:
                    return Value()
            if function.data == "print":
                tags: set[str] = set()
                for argument_value in args:
                    tags.update(value_tags(argument_value))
                warning = any(
                    value.kind == "sdk" and value.data == "sys.stderr"
                    for name, value in kwargs.items()
                    if name == "file"
                )
                self.record("print", tags=sorted(tags), warning=warning)
                return Value()
            if function.data == "isinstance" and len(args) >= 2:
                value, expected = args[:2]
                if value.kind == "event" and expected.kind == "sdk":
                    if expected.data == "azure.eventgrid.EventGridEvent":
                        return literal(value.data["schema"] == "eventgrid")
                    if expected.data == "azure.core.messaging.CloudEvent":
                        return literal(value.data["schema"] == "cloud")
                expected_values = (
                    expected.items if expected.kind == "tuple" else (expected,)
                )
                matches: list[bool] = []
                for candidate in expected_values:
                    origin = str(candidate.data)
                    if candidate.kind not in {"builtin", "sdk", "class"}:
                        continue
                    if origin in {"str", "builtins.str"}:
                        matches.append(
                            value.kind == "literal" and isinstance(value.data, str)
                        )
                    elif origin in {"bytes", "builtins.bytes"}:
                        matches.append(
                            value.kind == "literal" and isinstance(value.data, bytes)
                        )
                    elif origin in {"list", "builtins.list"}:
                        matches.append(value.kind == "list")
                    elif origin in {"tuple", "builtins.tuple"}:
                        matches.append(value.kind == "tuple")
                    elif origin in {"set", "builtins.set"}:
                        matches.append(value.kind == "set")
                    elif origin in {
                        "dict",
                        "builtins.dict",
                        "collections.abc.Mapping",
                        "typing.Mapping",
                    }:
                        matches.append(value.kind == "dict")
                    elif candidate.kind == "class" and value.kind == "instance":
                        matches.append(value.data is candidate.data)
                if matches:
                    return literal(any(matches))
                return Value()
            return Value()
        if function.kind == "sdk":
            return self.call_sdk(function.data, args, kwargs, awaited)
        if function.kind == "method":
            receiver, name = function.data
            return self.call_method(receiver, name, args, kwargs, awaited)
        return Value()

    def dispatch_function_call(
        self,
        target: FunctionInfo,
        instance: Value | None,
        args: list[Value],
        kwargs: dict[str, Value],
        *,
        awaited: bool,
    ) -> Value:
        payload = {
            "target": target,
            "instance": instance,
            "args": args,
            "kwargs": kwargs,
            "executed": False,
            "result": Value(),
        }
        if target.is_async_generator:
            return Value(kind="async-iterable", data=payload)
        if target.is_async and not awaited:
            return Value(kind="coroutine", data=payload)
        return self.invoke_function(target, instance, args, kwargs)

    def invoke_function(
        self,
        target: FunctionInfo,
        instance: Value | None,
        args: list[Value],
        kwargs: dict[str, Value],
    ) -> Value:
        operation_start = len(self.operations)
        result = self.call_function(target, instance, args, kwargs)
        operation_end = len(self.operations)
        if args and args[0].kind == "event":
            self.record(
                "event-call",
                target=target.key,
                event_id=args[0].data["id"],
                schema=args[0].data["schema"],
                event_type=args[0].data.get("type"),
                sample_valid=args[0].data.get("sample_valid", False),
                receiver_stack=args[0].data.get("receiver_stack", ()),
                operation_start=operation_start,
                operation_end=operation_end,
                **{"async": target.is_async},
            )
        return self.validated_subject_result(
            target,
            instance,
            args,
            kwargs,
            result,
        )

    def await_value(self, value: Value) -> Value:
        if value.kind == "task":
            return value.data
        if value.kind != "coroutine":
            return value
        payload = value.data
        if payload["executed"]:
            return payload["result"]
        payload["executed"] = True
        payload["result"] = self.invoke_function(
            payload["target"],
            payload["instance"],
            payload["args"],
            payload["kwargs"],
        )
        return payload["result"]

    def iterate_async_value(
        self,
        value: Value,
    ) -> tuple[AsyncIteration, ...] | None:
        if value.kind != "async-iterable":
            return None
        payload = value.data
        if payload["executed"]:
            return payload.get("iterations", ())
        payload["executed"] = True
        operation_start = len(self.operations)
        executed_before = set(self.executed)
        state_before = self.external_state_snapshot(
            [
                payload["instance"],
                *payload["args"],
                *payload["kwargs"].values(),
            ]
        )
        branch_start = self.next_branch
        caller_path = dict(self.path_constraints)
        terminal_outcomes: list[ExecOutcome] = []
        self.call_function(
            payload["target"],
            payload["instance"],
            payload["args"],
            payload["kwargs"],
            capture_outcomes=terminal_outcomes,
        )
        terminal_state = self.external_state_snapshot(
            [
                payload["instance"],
                *payload["args"],
                *payload["kwargs"].values(),
            ]
        )
        captured_operations = tuple(
            (operation_start + index, operation)
            for index, operation in enumerate(self.operations[operation_start:])
        )
        del self.operations[operation_start:]
        self.executed = executed_before
        self.restore_external_state(state_before)
        yields = [
            (position, operation)
            for position, operation in captured_operations
            if operation["kind"] == "yield"
        ]
        path_sources = [operation["path"] for _, operation in captured_operations] + [
            outcome.path for outcome in terminal_outcomes
        ]
        relevant_branches = sorted(
            {
                branch
                for path in path_sources
                for branch, _ in path
                if branch >= branch_start
            }
        )
        paths: list[dict[int, bool | str]] = []

        def expand_paths(
            index: int,
            constraints: dict[int, bool | str],
        ) -> None:
            if index == len(relevant_branches):
                paths.append(dict(constraints))
                return
            branch = relevant_branches[index]
            context = dict(self.branch_contexts.get(branch, ()))
            if any(
                constraints.get(parent) != choice for parent, choice in context.items()
            ):
                expand_paths(index + 1, constraints)
                return
            choices = sorted(
                self.branch_choices.get(branch, ()),
                key=repr,
            )
            if not choices:
                expand_paths(index + 1, constraints)
                return
            for choice in choices:
                constraints[branch] = choice
                expand_paths(index + 1, constraints)
            constraints.pop(branch, None)

        expand_paths(0, caller_path)
        if not paths:
            paths.append(caller_path)
        iterations = tuple(
            AsyncIteration(
                items=tuple(
                    operation["yielded"]
                    for _, operation in yields
                    if all(
                        path.get(branch) == choice
                        for branch, choice in operation["path"]
                    )
                ),
                path=tuple(sorted(path.items())),
                exhausted=any(
                    outcome.control in {"normal", "return"}
                    and all(
                        path.get(branch) == choice for branch, choice in outcome.path
                    )
                    for outcome in terminal_outcomes
                ),
                operations=tuple(
                    (position, operation)
                    for position, operation in captured_operations
                    if all(
                        path.get(branch) == choice
                        for branch, choice in operation["path"]
                    )
                ),
                yield_positions=tuple(
                    position
                    for position, operation in yields
                    if all(
                        path.get(branch) == choice
                        for branch, choice in operation["path"]
                    )
                ),
                state=payload,
            )
            for path in paths
        )
        payload["initial_state"] = state_before
        payload["terminal_state"] = terminal_state
        payload["iterations"] = iterations
        return iterations

    def commit_async_operations(
        self,
        iteration: AsyncIteration,
        through: int | None,
    ) -> None:
        if not self.resumed_generator_path_matches(iteration, through):
            return
        continuation = self.async_continuations.setdefault(
            id(iteration.state),
            {
                "committed_operations": set(),
                "operation_locations": {},
                "applied_state": iteration.state["initial_state"],
                "terminal_state_applied": False,
            },
        )
        committed: set[int] = continuation["committed_operations"]
        locations: dict[int, int] = continuation["operation_locations"]
        for position, operation in iteration.operations:
            if position in committed or (through is not None and position > through):
                continue
            if operation["kind"] == "resumed-generator-call":
                committed.add(position)
                saved_constraints = dict(self.path_constraints)
                previous_function = self.current_function
                previous_replaying = self.replaying_generator_call
                previous_stack = list(self.stack)
                try:
                    external_state = operation.get("external_state")
                    if external_state is not None:
                        self.apply_external_state_delta(
                            continuation["applied_state"],
                            external_state,
                        )
                        continuation["applied_state"] = external_state
                    self.path_constraints.clear()
                    self.path_constraints.update(operation["path"])
                    function = self.function(str(operation["function"]))
                    self.current_function = function
                    if function is not None:
                        self.stack.append(function.key)
                    self.replaying_generator_call = True
                    module = self.modules[str(operation["module"])]
                    self.eval_expr(
                        operation["expression"],
                        self.resumed_generator_replay_environment(
                            operation["expression"],
                            dict(operation["environment"]),
                            module,
                        ),
                        module,
                    )
                finally:
                    self.path_constraints.clear()
                    self.path_constraints.update(saved_constraints)
                    self.current_function = previous_function
                    self.replaying_generator_call = previous_replaying
                    self.stack[:] = previous_stack
                continue
            copied = dict(operation)
            external_state = copied.pop("external_state", None)
            if "operation_start" in copied and "operation_end" in copied:
                nested = [
                    location
                    for original, location in locations.items()
                    if copied["operation_start"] <= original < copied["operation_end"]
                ]
                copied["operation_start"] = (
                    min(nested) if nested else len(self.operations)
                )
                copied["operation_end"] = (
                    max(nested) + 1 if nested else len(self.operations)
                )
            copied["sequence"] = len(self.operations)
            locations[position] = len(self.operations)
            committed.add(position)
            self.operations.append(copied)
            self.executed.update(copied.get("stack", ()))
            if external_state is not None:
                self.apply_external_state_delta(
                    continuation["applied_state"],
                    external_state,
                )
                continuation["applied_state"] = external_state
        if through is None and not continuation["terminal_state_applied"]:
            self.apply_external_state_delta(
                continuation["applied_state"],
                iteration.state["terminal_state"],
            )
            continuation["applied_state"] = iteration.state["terminal_state"]
            continuation["terminal_state_applied"] = True

    def call_sdk(
        self,
        origin: str,
        args: list[Value],
        kwargs: dict[str, Value],
        awaited: bool,
    ) -> Value:
        if origin in {
            "azure.identity.DefaultAzureCredential",
            "azure.identity.aio.DefaultAzureCredential",
        }:
            return Value(
                kind="credential",
                data="async" if ".aio." in origin else "sync",
                tags=frozenset({"default-credential"}),
            )
        if origin in {"os.getenv", "os.environ.get"}:
            name = abstract_python_value(args[0]) if args else _UNKNOWN_LITERAL
            return (
                Value(kind="env", data=name)
                if isinstance(name, str)
                else Value()
            )
        if origin in {
            "azure.storage.blob.BlobServiceClient",
            "azure.storage.blob.aio.BlobServiceClient",
        }:
            endpoint = kwargs.get("account_url", args[0] if args else Value())
            credential = kwargs.get("credential", args[1] if len(args) > 1 else Value())
            mode = "async" if ".aio." in origin else "sync"
            secure = (
                endpoint.kind == "env"
                and "STORAGE" in endpoint.data.upper()
                and {"URL", "ENDPOINT"} & set(endpoint.data.upper().split("_"))
                and "default-credential" in value_tags(credential)
            )
            client_id = self.new_id()
            self.record(
                "blob-service", client_id=client_id, mode=mode, secure=bool(secure)
            )
            return Value(
                kind="blob-service",
                data={"id": client_id, "mode": mode, "secure": bool(secure)},
            )
        if origin in {
            "azure.storage.blob.BlobClient",
            "azure.storage.blob.aio.BlobClient",
        }:
            endpoint = kwargs.get("account_url", args[0] if args else Value())
            container = kwargs.get(
                "container_name",
                args[1] if len(args) > 1 else Value(),
            )
            blob_name = kwargs.get(
                "blob_name",
                args[2] if len(args) > 2 else Value(),
            )
            credential = kwargs.get(
                "credential",
                args[3] if len(args) > 3 else Value(),
            )
            mode = "async" if ".aio." in origin else "sync"
            secure = (
                endpoint.kind == "env"
                and "STORAGE" in endpoint.data.upper()
                and {"URL", "ENDPOINT"} & set(endpoint.data.upper().split("_"))
                and "default-credential" in value_tags(credential)
            )
            client_id = self.new_id()
            service = {"id": client_id, "mode": mode, "secure": bool(secure)}
            self.record(
                "blob-service",
                client_id=client_id,
                mode=mode,
                secure=bool(secure),
            )
            return self.make_blob_client(service, container, blob_name)
        if origin in {
            "azure.eventgrid.EventGridPublisherClient",
            "azure.eventgrid.aio.EventGridPublisherClient",
        }:
            endpoint = kwargs.get("endpoint", args[0] if args else Value())
            credential = kwargs.get("credential", args[1] if len(args) > 1 else Value())
            mode = "async" if ".aio." in origin else "sync"
            secure = (
                endpoint.kind == "env"
                and "EVENT" in endpoint.data.upper()
                and "GRID" in endpoint.data.upper()
                and "default-credential" in value_tags(credential)
            )
            client_id = self.new_id()
            self.record(
                "publisher-client", client_id=client_id, mode=mode, secure=secure
            )
            return Value(
                kind="publisher",
                data={"id": client_id, "mode": mode, "secure": secure},
            )
        if origin in {
            "azure.eventgrid.EventGridEvent.from_json",
            "azure.core.messaging.CloudEvent.from_json",
            "azure.eventgrid.EventGridEvent.from_dict",
            "azure.core.messaging.CloudEvent.from_dict",
        }:
            schema = "eventgrid" if "EventGridEvent" in origin else "cloud"
            payload = abstract_python_value(args[0]) if args else None
            event_type = None
            subject = None
            sample_valid = False
            if isinstance(payload, (str, bytes)):
                text = payload.decode() if isinstance(payload, bytes) else payload
                try:
                    data = json.loads(text)
                except (TypeError, ValueError):
                    data = {}
            elif isinstance(payload, dict):
                data = payload
            else:
                data = {}
            type_key = "eventType" if schema == "eventgrid" else "type"
            if isinstance(data, dict):
                event_type = data.get(type_key)
                subject = data.get("subject")
                sample_valid = (
                    valid_event_grid_sample(data)
                    if schema == "eventgrid"
                    else valid_cloud_event_sample(data)
                )
            event_id = self.new_id()
            receiver_stack = tuple(self.stack)
            self.record(
                "deserialize",
                event_id=event_id,
                schema=schema,
                event_type=event_type,
                sample_valid=sample_valid,
                receiver_stack=receiver_stack,
            )
            return Value(
                kind="event",
                data={
                    "id": event_id,
                    "schema": schema,
                    "type": event_type,
                    "subject": subject,
                    "sample_valid": sample_valid,
                    "receiver_stack": receiver_stack,
                },
                tags=frozenset({f"event:{schema}"}),
            )
        if origin in {
            "azure.eventgrid.EventGridEvent",
            "azure.core.messaging.CloudEvent",
        }:
            subject = kwargs.get("subject", args[0] if args else Value())
            event_type = kwargs.get("event_type", kwargs.get("type", Value()))
            data = kwargs.get("data", args[2] if len(args) > 2 else Value())
            event_id = self.new_id()
            hierarchy = (
                subject.kind == "literal"
                and isinstance(subject.data, str)
                and subject.data.startswith("/")
                and len([part for part in subject.data.split("/") if part]) >= 3
            )
            subject_input = has_subject_input(subject)
            data_input = has_data_input(data)
            self.record(
                "custom-event",
                event_id=event_id,
                hierarchy=hierarchy,
                subject_input=subject_input,
                data_input=data_input,
                subject_tags=sorted(value_tags(subject)),
                data_tags=sorted(value_tags(data)),
                stack=tuple(self.stack),
                event_type=event_type.data if event_type.kind == "literal" else None,
            )
            return Value(
                kind="custom-event",
                data={
                    "id": event_id,
                    "hierarchy": hierarchy,
                    "subject_input": subject_input,
                    "data_input": data_input,
                },
                tags=frozenset(
                    {
                        f"custom-event:{event_id}",
                        *value_tags(subject),
                        *value_tags(data),
                    }
                ),
            )
        if origin in {"logging.getLogger", "logging.Logger"}:
            return Value(kind="logger", data="logging.Logger-instance")
        if origin == "re.compile" and args:
            pattern = abstract_python_value(args[0])
            if isinstance(pattern, (str, bytes)):
                try:
                    return Value(kind="regex", data=re.compile(pattern))
                except re.error:
                    return Value()
        if origin in {
            "logging.info",
            "logging.warn",
            "logging.warning",
        }:
            tags: set[str] = set()
            for argument in args:
                tags.update(value_tags(argument))
            message = next(
                (
                    str(argument.data)
                    for argument in args
                    if argument.kind in {"literal", "text"}
                    and isinstance(argument.data, str)
                ),
                "",
            )
            self.record(
                "log",
                level=origin.rsplit(".", 1)[-1],
                tags=sorted(tags),
                message=message,
            )
            return Value()
        if origin == "pathlib.PurePosixPath":
            if args and args[0].kind == "literal" and isinstance(args[0].data, str):
                parts = tuple(
                    literal(part) for part in PurePosixPath(args[0].data).parts
                )
                return Value(kind="posix-path", items=parts)
            return Value()
        if origin == "asyncio.run":
            return self.await_value(args[0]) if args else Value()
        if origin in {
            "asyncio.create_task",
            "asyncio.ensure_future",
            "asyncio.run_coroutine_threadsafe",
            "asyncio.shield",
        }:
            result = self.await_value(args[0]) if args else Value()
            return Value(kind="task", data=result, tags=result.tags)
        if origin in {"asyncio.gather", "asyncio.wait"}:
            results = tuple(self.await_value(argument) for argument in args)
            return Value(
                kind="task",
                data=Value(
                    kind="tuple",
                    items=results,
                    tags=value_tags(Value(items=results)),
                ),
                tags=value_tags(Value(items=results)),
            )
        if origin in {
            "asyncio.get_event_loop",
            "asyncio.get_running_loop",
            "asyncio.new_event_loop",
        }:
            return Value(kind="event-loop")
        if origin == "asyncio.TaskGroup":
            return Value(kind="async-task-group")
        if origin in {"urllib.parse.unquote", "str"}:
            return args[0] if args else Value()
        return Value()

    def call_method(
        self,
        receiver: Value,
        name: str,
        args: list[Value],
        kwargs: dict[str, Value],
        awaited: bool,
    ) -> Value:
        if receiver.kind == "list":
            if name == "append" and args:
                receiver.items = (*receiver.items, args[0])
                return literal(None)
            if name == "extend" and args:
                items = iterable_value_items(args[0])
                if items is not None:
                    receiver.items = (*receiver.items, *items)
                return literal(None)
            if name == "insert" and len(args) >= 2 and args[0].kind == "literal":
                if isinstance(args[0].data, int):
                    items = list(receiver.items)
                    items.insert(args[0].data, args[1])
                    receiver.items = tuple(items)
                return literal(None)
            if name == "clear":
                receiver.items = ()
                return literal(None)
            if name == "pop":
                index = args[0].data if args and args[0].kind == "literal" else -1
                if not isinstance(index, int):
                    return Value()
                items = list(receiver.items)
                try:
                    result = items.pop(index)
                except IndexError:
                    return Value()
                receiver.items = tuple(items)
                return result
            if name == "remove" and args:
                items = list(receiver.items)
                index = next(
                    (
                        index
                        for index, item in enumerate(items)
                        if same_abstract_value(item, args[0])
                    ),
                    None,
                )
                if index is not None:
                    items.pop(index)
                    receiver.items = tuple(items)
                return literal(None)
            if name == "reverse":
                receiver.items = tuple(reversed(receiver.items))
                return literal(None)
            if name == "sort":
                if args or (
                    "key" in kwargs
                    and not (
                        kwargs["key"].kind == "literal" and kwargs["key"].data is None
                    )
                ):
                    return Value()
                reverse = kwargs.get("reverse", literal(False))
                if reverse.kind != "literal" or not isinstance(
                    reverse.data,
                    bool,
                ):
                    return Value()
                items = list(receiver.items)
                for index in range(1, len(items)):
                    item = items[index]
                    position = index
                    while position > 0:
                        comparison = compare_abstract_values(
                            items[position - 1],
                            item,
                        )
                        if comparison is None:
                            return Value()
                        should_move = comparison < 0 if reverse.data else comparison > 0
                        if not should_move:
                            break
                        items[position] = items[position - 1]
                        position -= 1
                    items[position] = item
                receiver.items = tuple(items)
                return literal(None)
        if receiver.kind == "dict":
            if name == "get":
                key = args[0].data if args and args[0].kind == "literal" else None
                return receiver.data.get(
                    key,
                    args[1] if len(args) > 1 else Value(),
                )
            if name == "update":
                if args:
                    if args[0].kind != "dict":
                        return Value()
                    receiver.data.update(args[0].data)
                receiver.data.update(kwargs)
                return literal(None)
            if name == "setdefault":
                if not args or args[0].kind != "literal":
                    return Value()
                key = args[0].data
                try:
                    if key not in receiver.data:
                        receiver.data[key] = args[1] if len(args) > 1 else literal(None)
                    return receiver.data[key]
                except TypeError:
                    return Value()
            if name == "pop":
                if not args or args[0].kind != "literal":
                    return Value()
                try:
                    if args[0].data in receiver.data:
                        return receiver.data.pop(args[0].data)
                except TypeError:
                    return Value()
                return args[1] if len(args) > 1 else Value()
            if name == "popitem":
                if not receiver.data:
                    return Value()
                key = next(reversed(receiver.data))
                return Value(
                    kind="tuple",
                    items=(literal(key), receiver.data.pop(key)),
                )
            if name == "clear":
                receiver.data.clear()
                return literal(None)
        if receiver.kind == "set":
            if kwargs:
                return Value()
            if name == "add" and len(args) == 1:
                receiver.items = unique_abstract_values((*receiver.items, args[0]))
                return literal(None)
            if name == "update":
                additions: list[Value] = []
                for argument in args:
                    items = iterable_value_items(argument)
                    if items is None:
                        return Value()
                    additions.extend(items)
                receiver.items = unique_abstract_values((*receiver.items, *additions))
                return literal(None)
            if name in {"difference_update", "intersection_update"}:
                operands: list[tuple[Value, ...]] = []
                for argument in args:
                    items = iterable_value_items(argument)
                    if items is None:
                        return Value()
                    operands.append(unique_abstract_values(items))
                if name == "difference_update":
                    receiver.items = tuple(
                        item
                        for item in receiver.items
                        if not any(
                            any(
                                same_abstract_value(item, candidate)
                                for candidate in operand
                            )
                            for operand in operands
                        )
                    )
                else:
                    receiver.items = tuple(
                        item
                        for item in receiver.items
                        if all(
                            any(
                                same_abstract_value(item, candidate)
                                for candidate in operand
                            )
                            for operand in operands
                        )
                    )
                return literal(None)
            if name == "symmetric_difference_update" and len(args) == 1:
                items = iterable_value_items(args[0])
                if items is None:
                    return Value()
                original = receiver.items
                operand = unique_abstract_values(items)
                receiver.items = unique_abstract_values(
                    tuple(
                        item
                        for item in original
                        if not any(
                            same_abstract_value(item, candidate)
                            for candidate in operand
                        )
                    )
                    + tuple(
                        item
                        for item in operand
                        if not any(
                            same_abstract_value(item, candidate)
                            for candidate in original
                        )
                    )
                )
                return literal(None)
            if name in {"discard", "remove"} and len(args) == 1:
                receiver.items = tuple(
                    item
                    for item in receiver.items
                    if not same_abstract_value(item, args[0])
                )
                return literal(None)
            if name == "pop" and not args:
                if not receiver.items:
                    return Value()
                result = receiver.items[0]
                receiver.items = receiver.items[1:]
                return result
            if name == "clear" and not args:
                receiver.items = ()
                return literal(None)
        if receiver.kind == "literal" and name in {"partition", "split", "rsplit"}:
            if isinstance(receiver.data, str) and args and args[0].kind == "literal":
                separator = args[0].data
                try:
                    result = getattr(receiver.data, name)(separator)
                    return Value(
                        kind="tuple" if name == "partition" else "list",
                        items=tuple(literal(item) for item in result),
                    )
                except (TypeError, ValueError):
                    return Value()
        if receiver.kind == "regex" and name in {"match", "search", "fullmatch"}:
            candidate = abstract_python_value(args[0]) if args else None
            if isinstance(candidate, (str, bytes)):
                result = getattr(receiver.data, name)(candidate)
                return (
                    Value(kind="regex-match", data=result)
                    if result is not None
                    else literal(None)
                )
            return Value()
        if receiver.kind == "regex-match" and name == "group" and args:
            group = abstract_python_value(args[0])
            try:
                return literal(receiver.data.group(group))
            except (IndexError, TypeError):
                return Value()
        if receiver.kind == "literal" and name == "join":
            if (
                isinstance(receiver.data, str)
                and args
                and args[0].kind in {"list", "tuple"}
                and all(item.kind == "literal" for item in args[0].items)
            ):
                try:
                    return literal(
                        receiver.data.join(str(item.data) for item in args[0].items)
                    )
                except (TypeError, ValueError):
                    return Value()
        if receiver.kind in {"list", "tuple"} and name == "index":
            if args and args[0].kind == "literal":
                for index, item in enumerate(receiver.items):
                    if item.kind == "literal" and item.data == args[0].data:
                        return literal(index)
            return Value()
        if receiver.kind == "blob-service":
            if name == "get_container_client":
                container = args[0] if args else kwargs.get("container", Value())
                return Value(
                    kind="container-client",
                    data={"service": receiver.data, "container": container},
                )
            if name == "get_blob_client":
                container = args[0] if args else kwargs.get("container", Value())
                blob_name = args[1] if len(args) > 1 else kwargs.get("blob", Value())
                return self.make_blob_client(receiver.data, container, blob_name)
            if name == "close":
                self.record(
                    "close",
                    client_id=receiver.data["id"],
                    mode=receiver.data["mode"],
                    awaited=awaited,
                )
                return Value()

        if receiver.kind == "container-client" and name == "get_blob_client":
            blob_name = args[0] if args else kwargs.get("blob", Value())
            return self.make_blob_client(
                receiver.data["service"],
                receiver.data["container"],
                blob_name,
            )
        if receiver.kind == "blob-client":
            blob_id = receiver.data["id"]
            if name == "close":
                self.record(
                    "close",
                    client_id=receiver.data["service"]["id"],
                    mode=receiver.data["service"]["mode"],
                    awaited=awaited,
                )
                return Value()
            if name == "get_blob_properties":
                self.record("properties", blob_id=blob_id, awaited=awaited)
                return Value(kind="properties", data=blob_id)
            if name == "download_blob":
                self.record("download", blob_id=blob_id, awaited=awaited)
                return Value(kind="downloader", data={"blob_id": blob_id})
        if receiver.kind == "downloader" and name in {"readall", "readinto", "chunks"}:
            self.record("read", blob_id=receiver.data["blob_id"], awaited=awaited)
            return Value(tags=frozenset({f"downloaded:{receiver.data['blob_id']}"}))
        if receiver.kind == "publisher":
            if name == "send":
                event_ids: list[int] = []
                values = (
                    args[0].items
                    if args and args[0].kind in {"list", "tuple"}
                    else tuple(args)
                )
                for value in values:
                    if value.kind == "custom-event":
                        event_ids.append(value.data["id"])
                self.record(
                    "send",
                    client_id=receiver.data["id"],
                    mode=receiver.data["mode"],
                    secure=receiver.data["secure"],
                    awaited=awaited,
                    event_ids=event_ids,
                    payload_tags=sorted(value_tags(args[0]) if args else frozenset()),
                    stack=tuple(self.stack),
                )
                return Value()
            if name == "close":
                self.record(
                    "close",
                    client_id=receiver.data["id"],
                    mode=receiver.data["mode"],
                    awaited=awaited,
                )
                return Value()
        if receiver.kind == "event-loop" and name in {
            "create_task",
            "run_until_complete",
        }:
            result = self.await_value(args[0]) if args else Value()
            return (
                Value(kind="task", data=result, tags=result.tags)
                if name == "create_task"
                else result
            )
        if receiver.kind == "async-task-group" and name == "create_task":
            result = self.await_value(args[0]) if args else Value()
            return Value(kind="task", data=result, tags=result.tags)
        if receiver.kind == "task" and name == "result":
            return receiver.data
        if receiver.kind == "logger" and name in {
            "warning",
            "warn",
            "error",
            "info",
            "exception",
        }:
            tags: set[str] = set()
            for argument in args:
                tags.update(value_tags(argument))
            message = next(
                (
                    str(argument.data)
                    for argument in args
                    if argument.kind in {"literal", "text"}
                    and isinstance(argument.data, str)
                ),
                "",
            )
            self.record(
                "log",
                level=name,
                tags=sorted(tags),
                message=message,
            )
            return Value()
        return Value()

    def augmented_value(
        self,
        left: Value,
        operator: ast.operator,
        right: Value,
    ) -> Value:
        if left.kind == "list":
            if isinstance(operator, ast.Add):
                items = iterable_value_items(right)
                if items is not None:
                    left.items = (*left.items, *items)
                return left
            if (
                isinstance(operator, ast.Mult)
                and right.kind == "literal"
                and isinstance(right.data, int)
            ):
                left.items = left.items * max(right.data, 0)
                return left
        if left.kind == "dict" and isinstance(operator, ast.BitOr):
            if right.kind == "dict":
                left.data.update(right.data)
            return left
        if left.kind == "set":
            items = iterable_value_items(right)
            if items is None:
                return left
            if isinstance(operator, ast.BitOr):
                left.items = unique_abstract_values((*left.items, *items))
                return left
            if isinstance(operator, ast.BitAnd):
                left.items = tuple(
                    item
                    for item in left.items
                    if any(same_abstract_value(item, other) for other in items)
                )
                return left
            if isinstance(operator, ast.Sub):
                left.items = tuple(
                    item
                    for item in left.items
                    if not any(same_abstract_value(item, other) for other in items)
                )
                return left
            if isinstance(operator, ast.BitXor):
                left_only = tuple(
                    item
                    for item in left.items
                    if not any(same_abstract_value(item, other) for other in items)
                )
                right_only = tuple(
                    item
                    for item in items
                    if not any(same_abstract_value(item, other) for other in left.items)
                )
                left.items = unique_abstract_values((*left_only, *right_only))
                return left
        if left.kind == "tuple":
            if isinstance(operator, ast.Add):
                items = iterable_value_items(right)
                if items is not None:
                    return Value(kind="tuple", items=(*left.items, *items))
            if (
                isinstance(operator, ast.Mult)
                and right.kind == "literal"
                and isinstance(right.data, int)
            ):
                return Value(
                    kind="tuple",
                    items=left.items * max(right.data, 0),
                )
        return unknown(left, right)

    @staticmethod
    def structured_result_items(result: Value) -> tuple[Value, ...] | None:
        if result.kind in {"list", "tuple"}:
            return result.items
        if result.kind == "instance":
            class_info: ClassInfo = result.data
            values = tuple(
                result.attrs.get(name, Value())
                for name, _ in class_info.fields
            )
            return values if class_info.dataclass else None
        return None

    @classmethod
    def subject_result_matches(cls, result: Value, subject: str) -> tuple[str, str] | None:
        items = cls.structured_result_items(result)
        if items is None or len(items) != 2:
            return None
        match = re.search(r"/containers/([^/]+)/blobs/(.+)", subject)
        if not match:
            return None
        expected = (unquote(match.group(1)), unquote(match.group(2)))
        actual = tuple(
            item.data if item.kind == "literal" and isinstance(item.data, str) else None
            for item in items
        )
        return actual if actual == expected else None

    def parser_contract_holds(
        self,
        function: FunctionInfo,
        instance: Value | None,
        args: list[Value],
        kwargs: dict[str, Value],
    ) -> bool:
        probes = (
            "/blobServices/default/containers/probe-a/blobs/nested/one.txt",
            "/blobServices/default/containers/probe-b/blobs/two/three.bin",
        )
        for subject in probes:
            probe_args = list(args)
            probe_args[0] = literal(subject)
            operation_count = len(self.operations)
            executed = set(self.executed)
            next_id = self.next_id
            next_branch = self.next_branch
            result = self.call_function(
                function,
                instance,
                probe_args,
                kwargs,
            )
            del self.operations[operation_count:]
            self.executed = executed
            self.next_id = next_id
            self.next_branch = next_branch
            if self.subject_result_matches(result, subject) is None:
                return False
        return True

    def validated_subject_result(
        self,
        function: FunctionInfo,
        instance: Value | None,
        args: list[Value],
        kwargs: dict[str, Value],
        result: Value,
    ) -> Value:
        if (
            not args
            or "event-subject" not in value_tags(args[0])
            or not isinstance(args[0].data, str)
        ):
            return result
        actual = self.subject_result_matches(result, args[0].data)
        if actual is None or not self.parser_contract_holds(
            function,
            instance,
            args,
            kwargs,
        ):
            return result
        parsed = (
            Value(
                kind="container",
                data=actual[0],
                tags=frozenset({"parsed-container"}),
            ),
            Value(
                kind="blob-name",
                data=actual[1],
                tags=frozenset({"parsed-blob-name"}),
            ),
        )
        if result.kind == "instance":
            class_info: ClassInfo = result.data
            for (name, _), value in zip(class_info.fields, parsed, strict=True):
                result.attrs[name] = value
            return result
        return Value(kind="tuple", items=parsed)

    def make_blob_client(
        self, service: dict[str, Any], container: Value, blob_name: Value
    ) -> Value:
        connected = "parsed-container" in value_tags(
            container
        ) and "parsed-blob-name" in value_tags(blob_name)
        blob_id = self.new_id()
        blob_name.tags = frozenset(set(blob_name.tags) | {f"summary:name:{blob_id}"})
        self.record(
            "blob-client",
            blob_id=blob_id,
            service_id=service["id"],
            mode=service["mode"],
            secure=service["secure"],
            connected=connected,
        )
        return Value(
            kind="blob-client",
            data={
                "id": blob_id,
                "service": service,
                "container": container,
                "blob_name": blob_name,
            },
            tags=frozenset({f"summary:name:{blob_id}"}),
        )

    def call_function(
        self,
        function: FunctionInfo,
        instance: Value | None,
        args: list[Value],
        kwargs: dict[str, Value],
        *,
        capture_outcomes: list[ExecOutcome] | None = None,
    ) -> Value:
        if function.key in self.stack or len(self.stack) >= 30:
            return Value()
        self.executed.add(function.key)
        self.stack.append(function.key)
        previous = self.current_function
        self.current_function = function
        if function.is_async_generator:
            self.generator_yield_counts.append(0)
            self.generator_replay_value_ids.append(set())
        module = self.modules[function.module]
        environment = dict(module.env)
        if function.closure is not None:
            environment.update(function.closure)
        for name in function_local_bindings(function.node):
            environment[name] = Value(kind="local-shadow", data=name)
        parameters = list(function.node.args.posonlyargs) + list(
            function.node.args.args
        )
        values = list(args)
        if instance is not None and parameters:
            environment[parameters[0].arg] = instance
            if function.is_async_generator:
                self.track_generator_replay_value(instance)
            parameters = parameters[1:]
        for index, parameter in enumerate(parameters):
            if parameter.arg in kwargs:
                value = kwargs[parameter.arg]
            elif index < len(values):
                value = values[index]
            else:
                value = Value()
            environment[parameter.arg] = tagged(
                value,
                f"input:{function.key}:{parameter.arg}",
            )
            if function.is_async_generator:
                self.track_generator_replay_value(environment[parameter.arg])
        for index, parameter in enumerate(function.node.args.kwonlyargs):
            if parameter.arg in kwargs:
                value = kwargs[parameter.arg]
            else:
                default = function.node.args.kw_defaults[index]
                value = (
                    self.eval_expr(default, environment, module)
                    if default is not None
                    else Value()
                )
            environment[parameter.arg] = tagged(
                value,
                f"input:{function.key}:{parameter.arg}",
            )
            if function.is_async_generator:
                self.track_generator_replay_value(environment[parameter.arg])
        result = self.exec_statements(function.node.body, environment, module)
        if capture_outcomes is not None:
            capture_outcomes.extend(result.outcomes)
        if function.is_async_generator:
            self.generator_yield_counts.pop()
            self.generator_replay_value_ids.pop()
        self.current_function = previous
        self.stack.pop()
        return result.value

    def exec_result(
        self,
        control: str,
        environment: dict[str, Value],
        value: Value | None = None,
    ) -> ExecResult:
        outcome = self.current_exec_outcome(control, environment, value)
        return ExecResult(
            returned=control == "return",
            broke=control == "break",
            continued=control == "continue",
            value=outcome.value,
            outcomes=(outcome,),
        )

    @staticmethod
    def merge_environments(
        environments: list[dict[str, Value]],
        target: dict[str, Value],
    ) -> None:
        if not environments:
            return
        names = set(target).union(*(set(environment) for environment in environments))
        for name in names:
            values = [
                environment.get(name, target.get(name, Value()))
                for environment in environments
            ]
            target[name] = (
                values[0]
                if all(value == values[0] for value in values[1:])
                else unknown(*values)
            )

    def combined_exec_result(
        self,
        outcomes: list[ExecOutcome],
        environment: dict[str, Value],
    ) -> ExecResult:
        normal = [
            outcome.environment for outcome in outcomes if outcome.control == "normal"
        ]
        self.merge_environments(normal, environment)
        controls = {outcome.control for outcome in outcomes}
        only = next(iter(controls)) if len(controls) == 1 else ""
        values = [outcome.value for outcome in outcomes if outcome.control == "return"]
        return ExecResult(
            returned=only == "return",
            broke=only == "break",
            continued=only == "continue",
            value=merge_return_values(values),
            outcomes=tuple(outcomes),
        )

    def continue_exec_result(
        self,
        result: ExecResult,
        remaining: list[ast.stmt],
        environment: dict[str, Value],
        module: ModuleInfo,
    ) -> ExecResult:
        outcomes = list(result.outcomes)
        if not outcomes:
            control = (
                "return"
                if result.returned
                else "break"
                if result.broke
                else "continue"
                if result.continued
                else "normal"
            )
            outcomes = [self.current_exec_outcome(control, environment, result.value)]
        expanded: list[ExecOutcome] = []
        saved_constraints = dict(self.path_constraints)
        for outcome in outcomes:
            if outcome.control != "normal" or not remaining:
                expanded.append(outcome)
                continue
            self.path_constraints.clear()
            self.path_constraints.update(outcome.path)
            self.activate_exec_outcome(outcome)
            nested = dict(outcome.environment)
            continued = self.exec_statements(remaining, nested, module)
            expanded.extend(continued.outcomes)
        self.path_constraints.clear()
        self.path_constraints.update(saved_constraints)
        return self.combined_exec_result(expanded, environment)

    def exec_statements(
        self,
        statements: list[ast.stmt],
        environment: dict[str, Value],
        module: ModuleInfo,
    ) -> ExecResult:
        for index, statement in enumerate(statements):
            remaining = statements[index + 1 :]
            if isinstance(statement, ast.Return):
                return self.exec_result(
                    "return",
                    environment,
                    self.eval_expr(statement.value, environment, module)
                    if statement.value
                    else Value(),
                )
            if isinstance(statement, ast.Raise):
                exception_value = Value()
                if statement.exc is not None:
                    self.eval_expr(statement.exc, environment, module)
                    exception_name = exception_expression_name(statement.exc)
                    if exception_name is not None:
                        exception_value = literal(exception_name)
                return self.exec_result(
                    "exception",
                    environment,
                    exception_value,
                )
            if isinstance(statement, ast.Assign):
                value = self.eval_expr(statement.value, environment, module)
                for target in statement.targets:
                    self.assign(target, value, environment, module)
            elif isinstance(statement, ast.AnnAssign) and statement.value:
                if self.current_function is None and not module.postponed_annotations:
                    self.eval_expr(statement.annotation, environment, module)
                self.assign(
                    statement.target,
                    self.eval_expr(statement.value, environment, module),
                    environment,
                    module,
                )
            elif isinstance(statement, ast.AnnAssign):
                if self.current_function is None and not module.postponed_annotations:
                    self.eval_expr(statement.annotation, environment, module)
            elif isinstance(statement, ast.AugAssign):
                left = self.eval_expr(statement.target, environment, module)
                right = self.eval_expr(statement.value, environment, module)
                self.assign(
                    statement.target,
                    self.augmented_value(left, statement.op, right),
                    environment,
                    module,
                )
            elif isinstance(statement, ast.Delete):
                for target in statement.targets:
                    self.delete(target, environment, module)
            elif isinstance(statement, ast.Expr):
                self.eval_expr(statement.value, environment, module)
            elif isinstance(statement, (ast.With, ast.AsyncWith)):
                nested = dict(environment)
                for item in statement.items:
                    value = self.eval_expr(
                        item.context_expr,
                        nested,
                        module,
                        awaited=isinstance(statement, ast.AsyncWith),
                    )
                    if item.optional_vars:
                        self.assign(item.optional_vars, value, nested, module)
                result = self.exec_statements(statement.body, nested, module)
                environment.update(nested)
                if any(outcome.control != "normal" for outcome in result.outcomes):
                    return self.continue_exec_result(
                        result,
                        remaining,
                        environment,
                        module,
                    )
            elif isinstance(statement, ast.AsyncFor):
                iterable = self.eval_expr(statement.iter, environment, module)
                iterations = self.iterate_async_value(iterable)
                if iterations is None:
                    return self.exec_result("exception", environment)
                completed: list[ExecOutcome] = []
                initial_external_state = self.external_state_snapshot(
                    environment.values()
                )
                initial_continuations = self.clone_async_continuations(
                    self.async_continuations
                )
                for iteration in iterations:
                    self.restore_external_state(initial_external_state)
                    self.async_continuations = self.clone_async_continuations(
                        initial_continuations
                    )
                    self.async_continuations[id(iteration.state)] = {
                        "committed_operations": set(),
                        "operation_locations": {},
                        "applied_state": iteration.state["initial_state"],
                        "terminal_state_applied": False,
                    }
                    outcomes = [
                        self.current_exec_outcome(
                            "normal",
                            environment,
                            path=iteration.path,
                        )
                    ]
                    for item_index, item in enumerate(iteration.items):
                        next_outcomes: list[ExecOutcome] = []
                        for outcome in outcomes:
                            if outcome.control != "normal":
                                next_outcomes.append(outcome)
                                continue
                            saved_constraints = dict(self.path_constraints)
                            self.path_constraints.clear()
                            self.path_constraints.update(outcome.path)
                            self.activate_exec_outcome(outcome)
                            self.commit_async_operations(
                                iteration,
                                iteration.yield_positions[item_index],
                            )
                            nested = dict(outcome.environment)
                            target = iteration.state.get("target")
                            if (
                                isinstance(target, FunctionInfo)
                                and target.closure is not None
                            ):
                                for name in target.closure_names:
                                    if name in target.closure:
                                        nested[name] = target.closure[name]
                            self.assign(statement.target, item, nested, module)
                            body_result = self.exec_statements(
                                statement.body,
                                nested,
                                module,
                            )
                            for body_outcome in body_result.outcomes:
                                if body_outcome.control == "break":
                                    next_outcomes.append(
                                        self.generator_consumer_outcome(
                                            body_outcome,
                                            iteration,
                                            "loop-break",
                                        )
                                    )
                                elif body_outcome.control == "continue":
                                    next_outcomes.append(
                                        self.generator_consumer_outcome(
                                            body_outcome,
                                            iteration,
                                            "normal",
                                        )
                                    )
                                else:
                                    if body_outcome.control == "normal":
                                        body_outcome = self.generator_consumer_outcome(
                                            body_outcome,
                                            iteration,
                                            "normal",
                                        )
                                    next_outcomes.append(body_outcome)
                            self.path_constraints.clear()
                            self.path_constraints.update(saved_constraints)
                        outcomes = next_outcomes
                    for outcome in outcomes:
                        if outcome.control == "loop-break":
                            completed.append(
                                self.derived_exec_outcome(outcome, "normal")
                            )
                        elif outcome.control == "normal":
                            self.activate_exec_outcome(outcome)
                            self.commit_async_operations(iteration, None)
                            if not iteration.exhausted:
                                completed.append(
                                    self.current_exec_outcome(
                                        "exception",
                                        outcome.environment,
                                        path=outcome.path,
                                    )
                                )
                                continue
                            saved_constraints = dict(self.path_constraints)
                            self.path_constraints.clear()
                            self.path_constraints.update(outcome.path)
                            nested = dict(outcome.environment)
                            result = self.exec_statements(
                                statement.orelse,
                                nested,
                                module,
                            )
                            completed.extend(result.outcomes)
                            self.path_constraints.clear()
                            self.path_constraints.update(saved_constraints)
                        else:
                            completed.append(outcome)
                return self.continue_exec_result(
                    self.combined_exec_result(completed, environment),
                    remaining,
                    environment,
                    module,
                )
            elif isinstance(statement, ast.For):
                iterable = self.eval_expr(statement.iter, environment, module)
                cardinality = static_iterable_cardinality(
                    statement.iter,
                    builtin_available=lambda name: (
                        name not in environment and name not in module.env
                    ),
                )
                items = (
                    tuple(
                        Value(
                            kind=item.kind,
                            data=item.data,
                            items=item.items,
                            tags=frozenset(set(item.tags) | set(iterable.tags)),
                            attrs=item.attrs,
                        )
                        for item in iterable.items
                    )
                    if iterable.kind in ITERABLE_VALUE_KINDS and iterable.tags
                    else iterable.items
                    if iterable.kind in ITERABLE_VALUE_KINDS
                    else ()
                    if cardinality == 0
                    else tuple(
                        unknown(iterable)
                        for _ in range(
                            min(cardinality, LOOP_FIXPOINT_LIMIT)
                            if cardinality is not None
                            else LOOP_FIXPOINT_LIMIT
                        )
                    )
                )
                unknown_cardinality = (
                    cardinality is None and iterable.kind not in ITERABLE_VALUE_KINDS
                )
                abstract_iterations = iterable.kind not in ITERABLE_VALUE_KINDS
                truncated = bool(
                    unknown_cardinality
                    or (cardinality is not None and cardinality > len(items))
                )
                loop_branch = self.branch_id() if unknown_cardinality else None
                target_names = {
                    node.id
                    for node in ast.walk(statement.target)
                    if isinstance(node, ast.Name)
                }

                def same_loop_environment(
                    left: dict[str, Value],
                    right: dict[str, Value],
                ) -> bool:
                    names = (set(left) | set(right)) - target_names
                    return all(left.get(name) == right.get(name) for name in names)

                def execute_iterations(
                    item_index: int,
                    outcome: ExecOutcome,
                    history: tuple[dict[str, Value], ...] = (),
                ) -> list[ExecOutcome]:
                    saved_constraints = dict(self.path_constraints)
                    self.path_constraints.clear()
                    self.path_constraints.update(outcome.path)
                    self.activate_exec_outcome(outcome)
                    if item_index >= len(items):
                        if truncated:
                            widened = dict(outcome.environment)
                            self.merge_environments(
                                [*history, outcome.environment],
                                widened,
                            )
                            nested = dict(widened)
                            self.assign(
                                statement.target,
                                unknown(iterable),
                                nested,
                                module,
                            )
                            body_result = self.exec_statements(
                                statement.body,
                                nested,
                                module,
                            )
                            widened_outcomes: list[ExecOutcome] = []
                            for body_outcome in body_result.outcomes:
                                if body_outcome.control == "return":
                                    widened_outcomes.append(body_outcome)
                                elif body_outcome.control == "break":
                                    widened_outcomes.append(
                                        self.derived_exec_outcome(
                                            body_outcome,
                                            "normal",
                                        )
                                    )
                                elif body_outcome.control in {"normal", "continue"}:
                                    self.path_constraints.clear()
                                    self.path_constraints.update(body_outcome.path)
                                    self.activate_exec_outcome(body_outcome)
                                    widened_environment = dict(body_outcome.environment)
                                    widened_outcomes.extend(
                                        self.exec_statements(
                                            statement.orelse,
                                            widened_environment,
                                            module,
                                        ).outcomes
                                    )
                                    if unknown_cardinality:
                                        widened_outcomes.append(
                                            self.derived_exec_outcome(
                                                body_outcome,
                                                "halt",
                                            )
                                        )
                                else:
                                    widened_outcomes.append(body_outcome)
                            self.path_constraints.clear()
                            self.path_constraints.update(saved_constraints)
                            return widened_outcomes
                        nested = dict(outcome.environment)
                        result = self.exec_statements(
                            statement.orelse,
                            nested,
                            module,
                        )
                        self.path_constraints.clear()
                        self.path_constraints.update(saved_constraints)
                        return list(result.outcomes)
                    if abstract_iterations and any(
                        same_loop_environment(outcome.environment, previous)
                        for previous in history
                    ):
                        repeated = dict(outcome.environment)
                        repeated_outcomes = list(
                            self.exec_statements(
                                statement.orelse,
                                repeated,
                                module,
                            ).outcomes
                        )
                        if unknown_cardinality:
                            repeated_outcomes.append(
                                self.derived_exec_outcome(outcome, "halt")
                            )
                        self.path_constraints.clear()
                        self.path_constraints.update(saved_constraints)
                        return repeated_outcomes
                    nested = dict(outcome.environment)
                    self.assign(statement.target, items[item_index], nested, module)
                    event = items[item_index]
                    operation_start = len(self.operations)
                    body_result = self.exec_statements(
                        statement.body,
                        nested,
                        module,
                    )
                    operation_end = len(self.operations)
                    if event.kind == "event" and self.current_function is not None:
                        self.record(
                            "event-call",
                            target=self.current_function.key,
                            event_id=event.data["id"],
                            schema=event.data["schema"],
                            event_type=event.data.get("type"),
                            sample_valid=event.data.get("sample_valid", False),
                            receiver_stack=event.data.get("receiver_stack", ()),
                            operation_start=operation_start,
                            operation_end=operation_end,
                            **{"async": self.current_function.is_async},
                        )
                    collected: list[ExecOutcome] = []
                    for body_outcome in body_result.outcomes:
                        if body_outcome.control == "return":
                            collected.append(body_outcome)
                        elif body_outcome.control == "break":
                            collected.append(
                                self.derived_exec_outcome(
                                    body_outcome,
                                    "normal",
                                )
                            )
                        elif body_outcome.control in {"normal", "continue"}:
                            if unknown_cardinality:
                                self.path_constraints.clear()
                                self.path_constraints.update(body_outcome.path)
                                self.activate_exec_outcome(body_outcome)
                                exhausted = dict(body_outcome.environment)
                                collected.extend(
                                    self.exec_statements(
                                        statement.orelse,
                                        exhausted,
                                        module,
                                    ).outcomes
                                )
                            collected.extend(
                                execute_iterations(
                                    item_index + 1,
                                    self.derived_exec_outcome(
                                        body_outcome,
                                        "normal",
                                    ),
                                    (*history, dict(outcome.environment)),
                                )
                            )
                        else:
                            collected.append(body_outcome)
                    self.path_constraints.clear()
                    self.path_constraints.update(saved_constraints)
                    return collected

                outcomes: list[ExecOutcome] = []
                if unknown_cardinality and loop_branch is not None:
                    saved_constraints = dict(self.path_constraints)
                    loop_external_state = self.external_state_snapshot(
                        environment.values()
                    )
                    loop_continuations = self.clone_async_continuations(
                        self.async_continuations
                    )
                    self.constrain_path(loop_branch, "zero")
                    zero_environment = dict(environment)
                    outcomes.extend(
                        self.exec_statements(
                            statement.orelse,
                            zero_environment,
                            module,
                        ).outcomes
                    )
                    self.restore_external_state(loop_external_state)
                    self.async_continuations = self.clone_async_continuations(
                        loop_continuations
                    )
                    self.constrain_path(loop_branch, "nonempty")
                    outcomes.extend(
                        execute_iterations(
                            0,
                            self.current_exec_outcome(
                                "normal",
                                environment,
                            ),
                        )
                    )
                    self.path_constraints.clear()
                    self.path_constraints.update(saved_constraints)
                else:
                    outcomes.extend(
                        execute_iterations(
                            0,
                            self.current_exec_outcome(
                                "normal",
                                environment,
                            ),
                        )
                    )
                return self.continue_exec_result(
                    self.combined_exec_result(outcomes, environment),
                    remaining,
                    environment,
                    module,
                )
            elif isinstance(statement, ast.While):
                outcomes: list[ExecOutcome] = []
                saved_constraints = dict(self.path_constraints)
                seen_environments: list[dict[str, Value]] = []
                work = [self.current_exec_outcome("normal", environment)]
                iterations = 0
                while work and iterations < LOOP_FIXPOINT_LIMIT:
                    entry = work.pop(0)
                    self.activate_exec_outcome(entry)
                    if any(
                        entry.environment == previous for previous in seen_environments
                    ):
                        outcomes.append(self.derived_exec_outcome(entry, "halt"))
                        continue
                    seen_environments.append(dict(entry.environment))
                    iterations += 1
                    self.path_constraints.clear()
                    self.path_constraints.update(entry.path)
                    condition = self.eval_condition(
                        statement.test,
                        entry.environment,
                        module,
                    )
                    branch = self.branch_id() if condition is None else None
                    entry_external_state = entry.external_state
                    entry_continuations = self.clone_async_continuations(
                        entry.async_continuations
                    )
                    if condition is not True:
                        if branch is not None:
                            self.constrain_path(branch, False)
                        zero_environment = dict(entry.environment)
                        outcomes.extend(
                            self.exec_statements(
                                statement.orelse,
                                zero_environment,
                                module,
                            ).outcomes
                        )
                    if condition is False:
                        continue
                    if entry_external_state is not None:
                        self.restore_external_state(entry_external_state)
                    self.async_continuations = self.clone_async_continuations(
                        entry_continuations
                    )
                    self.path_constraints.clear()
                    self.path_constraints.update(entry.path)
                    if branch is not None:
                        self.constrain_path(branch, True)
                    body_environment = dict(entry.environment)
                    body_result = self.exec_statements(
                        statement.body,
                        body_environment,
                        module,
                    )
                    for body_outcome in body_result.outcomes:
                        if body_outcome.control == "return":
                            outcomes.append(body_outcome)
                            continue
                        if body_outcome.control == "break":
                            outcomes.append(
                                self.derived_exec_outcome(
                                    body_outcome,
                                    "normal",
                                )
                            )
                            continue
                        if body_outcome.control not in {"normal", "continue"}:
                            outcomes.append(body_outcome)
                            continue
                        work.append(
                            self.derived_exec_outcome(
                                body_outcome,
                                "normal",
                            )
                        )
                if work:
                    widened = dict(work[0].environment)
                    self.merge_environments(
                        [
                            *seen_environments,
                            *(entry.environment for entry in work),
                        ],
                        widened,
                    )
                    widened_entry = self.derived_exec_outcome(
                        work[0],
                        "normal",
                        environment=widened,
                    )
                    self.activate_exec_outcome(widened_entry)
                    self.path_constraints.clear()
                    self.path_constraints.update(widened_entry.path)
                    condition = self.eval_condition(
                        statement.test,
                        widened,
                        module,
                    )
                    branch = self.branch_id() if condition is None else None
                    if condition is not True:
                        if branch is not None:
                            self.constrain_path(branch, False)
                        exhausted = dict(widened)
                        outcomes.extend(
                            self.exec_statements(
                                statement.orelse,
                                exhausted,
                                module,
                            ).outcomes
                        )
                    if condition is not False:
                        self.path_constraints.clear()
                        self.path_constraints.update(widened_entry.path)
                        if branch is not None:
                            self.constrain_path(branch, True)
                        body_result = self.exec_statements(
                            statement.body,
                            dict(widened),
                            module,
                        )
                        for body_outcome in body_result.outcomes:
                            if body_outcome.control == "return":
                                outcomes.append(body_outcome)
                            elif body_outcome.control == "break":
                                outcomes.append(
                                    self.derived_exec_outcome(
                                        body_outcome,
                                        "normal",
                                    )
                                )
                            elif body_outcome.control in {"normal", "continue"}:
                                outcomes.append(
                                    self.derived_exec_outcome(
                                        body_outcome,
                                        "halt",
                                    )
                                )
                            else:
                                outcomes.append(body_outcome)
                self.path_constraints.clear()
                self.path_constraints.update(saved_constraints)
                return self.continue_exec_result(
                    self.combined_exec_result(outcomes, environment),
                    remaining,
                    environment,
                    module,
                )
            elif isinstance(statement, ast.If):
                resumed_condition = self.resumed_generator_expression_uses_external(
                    statement.test,
                    environment,
                )
                condition = (
                    None
                    if resumed_condition
                    else self.eval_condition(
                        statement.test,
                        environment,
                        module,
                    )
                )
                if condition is True:
                    result = self.exec_statements(statement.body, environment, module)
                elif condition is False:
                    result = self.exec_statements(statement.orelse, environment, module)
                else:
                    branch = self.branch_id()
                    branch_external_state = self.external_state_snapshot(
                        environment.values()
                    )
                    branch_continuations = self.clone_async_continuations(
                        self.async_continuations
                    )
                    if resumed_condition:
                        self.resumed_generator_conditions[branch] = {
                            "expression": statement.test,
                            "environment": dict(environment),
                            "module": module.name,
                            "function": self.current_function.key,
                            "path": tuple(sorted(self.path_constraints.items())),
                            "position": len(self.operations),
                        }
                    left = dict(environment)
                    right = dict(environment)
                    self.constrain_path(branch, True)
                    left_result = self.exec_statements(statement.body, left, module)
                    self.restore_external_state(branch_external_state)
                    self.async_continuations = self.clone_async_continuations(
                        branch_continuations
                    )
                    self.constrain_path(branch, False)
                    right_result = self.exec_statements(statement.orelse, right, module)
                    del self.path_constraints[branch]
                    result = self.combined_exec_result(
                        [
                            *left_result.outcomes,
                            *right_result.outcomes,
                        ],
                        environment,
                    )
                    if len(result.outcomes) > 1:
                        return self.continue_exec_result(
                            result,
                            remaining,
                            environment,
                            module,
                        )
                    if any(outcome.control != "normal" for outcome in result.outcomes):
                        return self.continue_exec_result(
                            result,
                            remaining,
                            environment,
                            module,
                        )
                if any(
                    outcome.control != "normal" for outcome in result.outcomes
                ) and not (result.returned or result.broke or result.continued):
                    return self.continue_exec_result(
                        result,
                        remaining,
                        environment,
                        module,
                    )
                if result.returned or result.broke or result.continued:
                    return result
            elif isinstance(statement, (ast.Try, ast.TryStar)):
                branch = self.branch_id()
                initial = dict(environment)
                initial_external_state = self.external_state_snapshot(
                    environment.values()
                )
                initial_continuations = self.clone_async_continuations(
                    self.async_continuations
                )
                branch_outcomes: list[ExecOutcome] = []
                self.try_handlers[branch] = {
                    "stack": tuple(self.stack),
                    "path": dict(self.path_constraints),
                    "handlers": {
                        f"handler:{index}": self.exception_origins(
                            self.current_function,
                            handler,
                        )
                        for index, handler in enumerate(statement.handlers)
                        if self.current_function is not None
                    },
                }

                self.constrain_path(branch, "body")
                normal = dict(initial)
                normal_result = self.exec_statements(statement.body, normal, module)
                if not (
                    self.current_function and self.current_function.is_async_generator
                ):
                    normal_result = self.continue_exec_result(
                        normal_result,
                        statement.orelse,
                        normal,
                        module,
                    )
                    branch_outcomes.extend(normal_result.outcomes)
                    for index, handler in enumerate(statement.handlers):
                        self.restore_external_state(initial_external_state)
                        self.async_continuations = self.clone_async_continuations(
                            initial_continuations
                        )
                        choice = f"handler:{index}"
                        self.constrain_path(branch, choice)
                        handled = dict(initial)
                        if handler.name:
                            handled[handler.name] = Value()
                        handler_result = self.exec_statements(
                            handler.body,
                            handled,
                            module,
                        )
                        branch_outcomes.extend(handler_result.outcomes)
                else:
                    for attempted in normal_result.outcomes:
                        self.path_constraints.clear()
                        self.path_constraints.update(attempted.path)
                        self.activate_exec_outcome(attempted)
                        if attempted.control == "normal":
                            normal_environment = dict(attempted.environment)
                            branch_outcomes.extend(
                                self.exec_statements(
                                    statement.orelse,
                                    normal_environment,
                                    module,
                                ).outcomes
                            )
                            continue
                        if attempted.control != "exception":
                            branch_outcomes.append(attempted)
                            continue

                        exception_name = (
                            str(attempted.value.data)
                            if (
                                attempted.value.kind == "literal"
                                and isinstance(attempted.value.data, str)
                            )
                            else None
                        )
                        matched = False
                        uncertain = False
                        for index, handler in enumerate(statement.handlers):
                            self.activate_exec_outcome(attempted)
                            match = handler_matches_exception(
                                handler,
                                exception_name,
                            )
                            if match is False:
                                continue
                            choice = f"handler:{index}"
                            self.constrain_path(branch, choice)
                            handled = dict(attempted.environment)
                            if handler.name:
                                handled[handler.name] = attempted.value
                            handler_result = self.exec_statements(
                                handler.body,
                                handled,
                                module,
                            )
                            branch_outcomes.extend(handler_result.outcomes)
                            matched = matched or match is True
                            uncertain = uncertain or match is None
                            if match is True:
                                break
                        if not matched or uncertain:
                            branch_outcomes.append(attempted)

                finalized: list[ExecOutcome] = []
                for branch_outcome in branch_outcomes:
                    self.path_constraints.clear()
                    self.path_constraints.update(branch_outcome.path)
                    self.activate_exec_outcome(branch_outcome)
                    branch_environment = dict(branch_outcome.environment)
                    final_result = self.exec_statements(
                        statement.finalbody,
                        branch_environment,
                        module,
                    )
                    for final_outcome in final_result.outcomes:
                        finalized.append(
                            final_outcome
                            if final_outcome.control != "normal"
                            else self.derived_exec_outcome(
                                final_outcome,
                                branch_outcome.control,
                                value=branch_outcome.value,
                            )
                        )
                self.path_constraints.clear()
                self.path_constraints.update(self.try_handlers[branch]["path"])
                return self.continue_exec_result(
                    self.combined_exec_result(finalized, environment),
                    remaining,
                    environment,
                    module,
                )
            elif isinstance(statement, ast.Match):
                subject_value = self.eval_expr(
                    statement.subject,
                    environment,
                    module,
                )
                if subject_value.kind == "literal":
                    subject = subject_value.data
                elif subject_value.kind in {"list", "tuple"} and all(
                    item.kind == "literal" for item in subject_value.items
                ):
                    values = [item.data for item in subject_value.items]
                    subject = values if subject_value.kind == "list" else tuple(values)
                elif subject_value.kind == "dict" and all(
                    item.kind == "literal" for item in subject_value.data.values()
                ):
                    subject = {
                        key: item.data for key, item in subject_value.data.items()
                    }
                else:
                    subject = _UNKNOWN_LITERAL
                branch = self.branch_id()
                match_external_state = self.external_state_snapshot(
                    environment.values()
                )
                match_continuations = self.clone_async_continuations(
                    self.async_continuations
                )
                outcomes: list[ExecOutcome] = []
                exhaustive = False
                for index, case in enumerate(statement.cases):
                    matches = static_match_pattern(case.pattern, subject)
                    if matches is False:
                        continue
                    self.restore_external_state(match_external_state)
                    self.async_continuations = self.clone_async_continuations(
                        match_continuations
                    )
                    choice = f"case:{index}"
                    self.constrain_path(branch, choice)
                    nested = dict(environment)
                    for name in match_bound_names(case.pattern):
                        nested[name] = subject_value
                    guard = (
                        self.eval_condition(case.guard, nested, module)
                        if case.guard is not None
                        else True
                    )
                    if guard is False:
                        continue
                    result = self.exec_statements(case.body, nested, module)
                    outcomes.extend(result.outcomes)
                    if matches is True and guard is True:
                        exhaustive = True
                        break
                if not exhaustive:
                    self.restore_external_state(match_external_state)
                    self.async_continuations = self.clone_async_continuations(
                        match_continuations
                    )
                    self.constrain_path(branch, "unmatched")
                    outcomes.append(self.current_exec_outcome("normal", environment))
                del self.path_constraints[branch]
                return self.continue_exec_result(
                    self.combined_exec_result(outcomes, environment),
                    remaining,
                    environment,
                    module,
                )
            elif isinstance(
                statement,
                (
                    ast.Import,
                    ast.ImportFrom,
                ),
            ):
                self.bind_statement(statement, environment, module)
            elif isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                decorators = [
                    self.eval_expr(expression, environment, module)
                    for expression in statement.decorator_list
                ]
                for expression in (
                    *statement.args.defaults,
                    *(
                        default
                        for default in statement.args.kw_defaults
                        if default is not None
                    ),
                    *(
                        ()
                        if module.postponed_annotations
                        else function_annotation_expressions(statement)
                    ),
                ):
                    self.eval_expr(expression, environment, module)
                self.bind_statement(statement, environment, module)
                defined = environment[statement.name]
                for decorator in reversed(decorators):
                    decorated = self.call(
                        decorator,
                        [defined],
                        {},
                        module,
                        awaited=False,
                    )
                    if decorated.kind != "unknown":
                        defined = decorated
                environment[statement.name] = defined
                if self.current_function is None:
                    module.env[statement.name] = defined
            elif isinstance(statement, ast.ClassDef):
                decorators = [
                    self.eval_expr(expression, environment, module)
                    for expression in statement.decorator_list
                ]
                for expression in (
                    *statement.bases,
                    *(keyword.value for keyword in statement.keywords),
                ):
                    self.eval_expr(expression, environment, module)
                class_environment = dict(environment)
                result = self.exec_statements(
                    statement.body,
                    class_environment,
                    module,
                )
                self.bind_statement(statement, environment, module)
                defined = environment[statement.name]
                for decorator in reversed(decorators):
                    decorated = self.call(
                        decorator,
                        [defined],
                        {},
                        module,
                        awaited=False,
                    )
                    if decorated.kind != "unknown":
                        defined = decorated
                environment[statement.name] = defined
                if self.current_function is None:
                    module.env[statement.name] = defined
                if result.returned or result.broke or result.continued:
                    return result
            elif isinstance(statement, ast.Assert):
                condition = self.eval_condition(statement.test, environment, module)
                if condition is not True and statement.msg is not None:
                    self.eval_expr(statement.msg, environment, module)
            elif isinstance(statement, ast.Break):
                return self.exec_result("break", environment)
            elif isinstance(statement, ast.Continue):
                return self.exec_result("continue", environment)
        return self.exec_result("normal", environment)

    def assign(
        self,
        target: ast.expr,
        value: Value,
        environment: dict[str, Value],
        module: ModuleInfo,
    ) -> None:
        if isinstance(target, ast.Name):
            environment[target.id] = value
            if self.current_function is None:
                module.env[target.id] = value
            else:
                globals_, nonlocals = function_scope_declarations(
                    self.current_function.node
                )
                if target.id in globals_:
                    module.env[target.id] = value
                elif (
                    target.id in nonlocals and self.current_function.closure is not None
                ):
                    self.current_function.closure[target.id] = value
        elif isinstance(target, (ast.Tuple, ast.List)):
            for index, item in enumerate(target.elts):
                assigned = value.items[index] if index < len(value.items) else Value()
                self.assign(item, assigned, environment, module)
        elif isinstance(target, ast.Attribute):
            base = self.eval_expr(
                target.value,
                environment,
                module,
            )
            if base.kind == "instance":
                base.attrs[target.attr] = value
        elif isinstance(target, ast.Subscript):
            base = self.eval_expr(target.value, environment, module)
            if isinstance(target.slice, ast.Slice):
                if base.kind != "list" or value.kind not in {"list", "tuple"}:
                    return
                bounds = [
                    self.eval_expr(bound, environment, module)
                    if bound is not None
                    else literal(None)
                    for bound in (
                        target.slice.lower,
                        target.slice.upper,
                        target.slice.step,
                    )
                ]
                if not all(bound.kind == "literal" for bound in bounds):
                    return
                items = list(base.items)
                try:
                    items[slice(*(bound.data for bound in bounds))] = value.items
                except (TypeError, ValueError):
                    return
                base.items = tuple(items)
                return
            index = self.eval_expr(target.slice, environment, module)
            if index.kind != "literal":
                return
            if base.kind == "list":
                items = list(base.items)
                try:
                    if isinstance(index.data, slice):
                        if value.kind not in {"list", "tuple"}:
                            return
                        items[index.data] = value.items
                    else:
                        items[index.data] = value
                except (IndexError, TypeError, ValueError):
                    return
                base.items = tuple(items)
            elif base.kind == "dict" and isinstance(base.data, dict):
                try:
                    base.data[index.data] = value
                except TypeError:
                    return

    def delete(
        self,
        target: ast.expr,
        environment: dict[str, Value],
        module: ModuleInfo,
    ) -> None:
        if isinstance(target, ast.Name):
            deleted = Value(kind="deleted", data=target.id)
            environment[target.id] = deleted
            if self.current_function is None:
                module.env[target.id] = deleted
                return
            globals_, nonlocals = function_scope_declarations(
                self.current_function.node
            )
            if target.id in globals_:
                module.env[target.id] = deleted
            elif target.id in nonlocals and self.current_function.closure is not None:
                self.current_function.closure[target.id] = deleted
        elif isinstance(target, (ast.Tuple, ast.List)):
            for item in target.elts:
                self.delete(item, environment, module)
        elif isinstance(target, ast.Attribute):
            base = self.eval_expr(target.value, environment, module)
            if base.kind == "instance":
                base.attrs.pop(target.attr, None)
        elif isinstance(target, ast.Subscript):
            base = self.eval_expr(target.value, environment, module)
            if isinstance(target.slice, ast.Slice):
                if base.kind != "list":
                    return
                bounds = [
                    self.eval_expr(bound, environment, module)
                    if bound is not None
                    else literal(None)
                    for bound in (
                        target.slice.lower,
                        target.slice.upper,
                        target.slice.step,
                    )
                ]
                if not all(bound.kind == "literal" for bound in bounds):
                    return
                items = list(base.items)
                try:
                    del items[slice(*(bound.data for bound in bounds))]
                except (TypeError, ValueError):
                    return
                base.items = tuple(items)
                return
            index = self.eval_expr(target.slice, environment, module)
            if index.kind != "literal":
                return
            if base.kind == "list":
                items = list(base.items)
                try:
                    del items[index.data]
                except (IndexError, TypeError, ValueError):
                    return
                base.items = tuple(items)
            elif base.kind == "dict" and isinstance(base.data, dict):
                try:
                    base.data.pop(index.data, None)
                except TypeError:
                    return

    def is_subject_parser(self, function: FunctionInfo) -> bool:
        parameters = list(function.node.args.posonlyargs) + list(
            function.node.args.args
        )
        if function.class_key and parameters:
            parameters = parameters[1:]
        if not parameters:
            return False
        derived = {parameters[0].arg}

        def mark_target(target: ast.expr) -> bool:
            changed = False
            if isinstance(target, ast.Name) and target.id not in derived:
                derived.add(target.id)
                changed = True
            elif isinstance(target, (ast.Tuple, ast.List)):
                for item in target.elts:
                    changed = mark_target(item) or changed
            return changed

        def expression_is_derived(node: ast.expr) -> bool:
            if isinstance(node, ast.Name):
                return node.id in derived
            if isinstance(node, ast.Attribute):
                return expression_is_derived(node.value)
            if isinstance(node, ast.Subscript):
                return expression_is_derived(node.value)
            if isinstance(node, ast.Call):
                return (
                    expression_is_derived(node.func)
                    or any(expression_is_derived(argument) for argument in node.args)
                    or any(
                        expression_is_derived(keyword.value)
                        for keyword in node.keywords
                    )
                )
            if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
                return any(expression_is_derived(item) for item in node.elts)
            if isinstance(node, ast.BinOp):
                return expression_is_derived(node.left) or expression_is_derived(
                    node.right
                )
            if isinstance(node, ast.BoolOp):
                return any(expression_is_derived(value) for value in node.values)
            if isinstance(node, ast.IfExp):
                return expression_is_derived(node.body) or expression_is_derived(
                    node.orelse
                )
            return False

        assignments = [
            node
            for node in ast.walk(function.node)
            if isinstance(node, (ast.Assign, ast.AnnAssign))
        ]
        changed = True
        while changed:
            changed = False
            for assignment in assignments:
                value = assignment.value
                if value is None or not expression_is_derived(value):
                    continue
                targets = (
                    assignment.targets
                    if isinstance(assignment, ast.Assign)
                    else [assignment.target]
                )
                for target in targets:
                    changed = mark_target(target) or changed

        delimiters: set[str] = set()
        indexes: set[str] = set()
        regex = False
        module = self.modules[function.module]
        for node in ast.walk(function.node):
            if not isinstance(node, ast.Call):
                continue
            if isinstance(node.func, ast.Attribute):
                if (
                    node.func.attr in {"partition", "split", "rsplit"}
                    and expression_is_derived(node.func.value)
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value in {"/containers/", "/blobs/"}
                ):
                    delimiters.add(node.args[0].value)
                if (
                    node.func.attr in {"index", "find"}
                    and expression_is_derived(node.func.value)
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and node.args[0].value in {"containers", "blobs"}
                ):
                    indexes.add(node.args[0].value)
            origin = dotted(node.func) or ""
            if (
                origin in {"re.match", "re.search", "re.fullmatch"}
                and len(node.args) >= 2
            ):
                pattern = node.args[0]
                if (
                    isinstance(pattern, ast.Constant)
                    and isinstance(pattern.value, str)
                    and "containers/" in pattern.value
                    and "blobs/" in pattern.value
                    and expression_is_derived(node.args[1])
                ):
                    regex = True
            if (
                isinstance(node.func, ast.Attribute)
                and node.func.attr in {"match", "search", "fullmatch"}
                and node.args
                and expression_is_derived(node.args[0])
                and isinstance(node.func.value, ast.Name)
            ):
                pattern = module.env.get(node.func.value.id)
                if (
                    pattern is not None
                    and pattern.kind == "regex"
                    and "containers/" in str(pattern.data.pattern)
                    and "blobs/" in str(pattern.data.pattern)
                ):
                    regex = True

        def returns_structured_pair(node: ast.Return) -> bool:
            if isinstance(node.value, (ast.Tuple, ast.List)):
                return len(node.value.elts) == 2 and all(
                    expression_is_derived(item) for item in node.value.elts
                )
            if not isinstance(node.value, ast.Call):
                return False
            target = (
                module.env.get(node.value.func.id)
                if isinstance(node.value.func, ast.Name)
                else None
            )
            if (
                target is None
                or target.kind != "class"
                or not target.data.dataclass
                or len(target.data.fields) != 2
            ):
                return False
            values = [
                *node.value.args,
                *(
                    keyword.value
                    for keyword in node.value.keywords
                    if keyword.arg is not None
                ),
            ]
            return len(values) == 2 and all(expression_is_derived(item) for item in values)

        returns_pair = any(
            isinstance(node, ast.Return) and returns_structured_pair(node)
            for node in ast.walk(function.node)
        )
        return returns_pair and (
            delimiters == {"/containers/", "/blobs/"}
            or indexes == {"containers", "blobs"}
            or regex
        )

    def imported_origin(self, module: ModuleInfo, node: ast.expr) -> str | None:
        if isinstance(node, ast.Name):
            value = module.env.get(node.id)
            if value and value.kind == "sdk":
                return str(value.data)
            return None
        if isinstance(node, ast.Attribute):
            if (
                isinstance(node.value, ast.Call)
                and isinstance(node.value.func, ast.Name)
                and node.value.func.id == "__import__"
                and node.value.args
                and isinstance(node.value.args[0], ast.Constant)
                and isinstance(node.value.args[0].value, str)
            ):
                return f"{node.value.args[0].value}.{node.attr}"
            parent = self.imported_origin(module, node.value)
            if parent:
                return f"{parent}.{node.attr}"
            if isinstance(node.value, ast.Name):
                value = module.env.get(node.value.id)
                if value and value.kind in {"module", "sdk"}:
                    return f"{value.data}.{node.attr}"
        return None

    def exception_origins(
        self,
        function: FunctionInfo | None,
        handler: ast.ExceptHandler,
    ) -> set[str]:
        if handler.type is None:
            return {"bare"}
        if function is None:
            return set()
        nodes = (
            handler.type.elts if isinstance(handler.type, ast.Tuple) else [handler.type]
        )
        module = self.modules[function.module]
        return {
            origin
            for node in nodes
            if (origin := self.imported_origin(module, node)) is not None
        }

    def meaningful_handler(
        self,
        function: FunctionInfo,
        handler: ast.ExceptHandler,
    ) -> bool:
        module = self.modules[function.module]
        for node in ast.walk(ast.Module(body=handler.body, type_ignores=[])):
            if isinstance(node, ast.Call) and self.standard_warning_call(
                function,
                module,
                node,
                levels={"error", "exception", "info", "warn", "warning"},
            ):
                return True
        return False

    def has_handling(
        self,
        function_key: str,
        operation_names: set[str],
        required: set[str],
        broad: set[str],
    ) -> bool:
        function = self.function(function_key)
        if not function:
            return False
        for node in ast.walk(function.node):
            if not isinstance(node, ast.Try):
                continue
            body_methods = {
                call.func.attr
                for statement in node.body
                for call in ast.walk(statement)
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute)
            }
            body_methods.update(
                call.func.id
                for statement in node.body
                for call in ast.walk(statement)
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Name)
            )
            if not operation_names & body_methods:
                continue
            handled: set[str] = set()
            for handler in node.handlers:
                if self.meaningful_handler(function, handler):
                    handled.update(self.exception_origins(function, handler))
            if required <= handled and handled & broad:
                return True
        return False

    def operation_has_handling(
        self,
        operation: dict[str, Any],
        operation_names: set[str],
        required: set[str],
        broad: set[str],
    ) -> bool:
        del operation_names
        operation_path = dict(operation.get("path", ()))
        for branch, choice in operation_path.items():
            if choice != "body" or branch not in self.try_handlers:
                continue
            handling = self.try_handlers[branch]
            handled: set[str] = set()
            for handler_choice, origins in handling["handlers"].items():
                if not any(
                    self.handler_operation_is_meaningful(candidate)
                    and self.paths_are_compatible(
                        dict(candidate.get("path", ())),
                        handling["path"],
                        branch,
                        handler_choice,
                    )
                    and tuple(candidate.get("stack", ()))[: len(handling["stack"])]
                    == handling["stack"]
                    for candidate in self.operations
                ):
                    continue
                handled.update(origins)
            if required <= handled and handled & broad:
                return True
        return False

    @staticmethod
    def handler_operation_is_meaningful(operation: dict[str, Any]) -> bool:
        if operation["kind"] == "log":
            return operation.get("level") in {
                "error",
                "exception",
                "info",
                "warn",
                "warning",
            }
        if operation["kind"] == "print":
            return bool(operation.get("warning"))
        if operation["kind"] != "origin-call":
            return False
        origin = str(operation.get("origin", ""))
        return (
            origin == "warnings.warn"
            or origin == "sys.stderr.write"
            or origin.rsplit(".", 1)[-1]
            in {"error", "exception", "info", "warn", "warning"}
            and origin.startswith("logging.")
        )

    @staticmethod
    def paths_are_compatible(
        handler_path: dict[int, bool | str],
        owner_path: dict[int, bool | str],
        branch: int,
        handler_choice: str,
    ) -> bool:
        if handler_path.get(branch) != handler_choice:
            return False
        return all(handler_path.get(key) == value for key, value in owner_path.items())

    def function(self, key: str) -> FunctionInfo | None:
        if key in self.dynamic_functions:
            return self.dynamic_functions[key]
        for module in self.modules.values():
            for function in module.functions.values():
                if function.key == key:
                    return function
            for class_info in module.classes.values():
                for function in class_info.methods.values():
                    if function.key == key:
                        return function
        return None

    def route_functions(self) -> dict[str, dict[str, Any]]:
        routes: dict[str, dict[str, Any]] = {}
        for key in self.executed:
            function = self.function(key)
            if not function:
                continue
            module = self.modules[function.module]
            event_type_states = self.event_type_states(function)
            for node in ast.walk(function.node):
                if not isinstance(node, ast.If):
                    continue
                chain: list[tuple[ast.expr, list[ast.stmt]]] = []
                current = node
                final_else: list[ast.stmt] = []
                while True:
                    chain.append((current.test, current.body))
                    if len(current.orelse) == 1 and isinstance(
                        current.orelse[0], ast.If
                    ):
                        current = current.orelse[0]
                    else:
                        final_else = current.orelse
                        break
                created_body = None
                deleted_body = None
                event_type_names, expected_values = event_type_states.get(
                    id(node),
                    (set(), {}),
                )
                for test, body in chain:
                    if self.positive_event_type_test(
                        test,
                        event_type_names,
                        expected_values,
                        "Microsoft.Storage.BlobCreated",
                    ):
                        created_body = body
                    if self.positive_event_type_test(
                        test,
                        event_type_names,
                        expected_values,
                        "Microsoft.Storage.BlobDeleted",
                    ):
                        deleted_body = body
                warning = self.statements_warn(
                    final_else,
                    module,
                    function=function,
                )
                if (
                    created_body is not None
                    and deleted_body is not None
                    and warning
                    and event_type_names
                ):
                    routes[key] = {
                        "async": function.is_async,
                        "created_calls": self.local_calls(created_body, module),
                        "deleted_calls": self.local_calls(deleted_body, module),
                    }
        return routes

    def positive_event_type_test(
        self,
        node: ast.expr,
        event_type_names: set[str],
        expected_values: dict[str, str],
        expected: str,
    ) -> bool:
        if (
            not isinstance(node, ast.Compare)
            or len(node.ops) != 1
            or len(node.comparators) != 1
            or not isinstance(node.ops[0], (ast.Eq, ast.Is))
        ):
            return False
        left, right = node.left, node.comparators[0]
        left_type = self.expression_uses_names(left, event_type_names)
        right_type = self.expression_uses_names(right, event_type_names)
        if left_type == right_type:
            return False
        constant = right if left_type else left
        return self.exact_string_value(constant, expected_values) == expected

    @classmethod
    def exact_string_value(
        cls,
        node: ast.expr,
        environment: dict[str, str],
    ) -> str | None:
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            return environment.get(node.id)
        if isinstance(node, ast.Attribute):
            return environment.get(dotted(node) or "")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            left = cls.exact_string_value(node.left, environment)
            right = cls.exact_string_value(node.right, environment)
            return left + right if left is not None and right is not None else None
        if isinstance(node, ast.IfExp):
            left = cls.exact_string_value(node.body, environment)
            right = cls.exact_string_value(node.orelse, environment)
            return left if left is not None and left == right else None
        return None

    def event_type_states(
        self,
        function: FunctionInfo,
    ) -> dict[int, tuple[set[str], dict[str, str]]]:
        parameters = self.parameter_nodes(function)
        if not parameters:
            return {}
        module = self.modules[function.module]
        state = tuple[str, str | None]
        other: state = ("other", None)
        states: dict[int, tuple[set[str], dict[str, str]]] = {}
        initial = {
            name: ("string", value.data)
            for name, value in module.env.items()
            if value.kind == "literal" and isinstance(value.data, str)
        }
        for name, value in module.env.items():
            if (
                value.kind == "sdk"
                and value.data == "azure.eventgrid.SystemEventNames"
            ):
                initial[f"{name}.StorageBlobCreated"] = (
                    "string",
                    "Microsoft.Storage.BlobCreated",
                )
                initial[f"{name}.StorageBlobDeleted"] = (
                    "string",
                    "Microsoft.Storage.BlobDeleted",
                )
        initial.update({name: other for name in function_local_bindings(function.node)})
        initial.update({parameter.arg: other for parameter in parameters})
        initial[parameters[0].arg] = ("event", None)

        def local_function(node: ast.expr) -> FunctionInfo | None:
            if not isinstance(node, ast.Name):
                return None
            value = module.env.get(node.id)
            return value.data if value is not None and value.kind == "function" else None

        def function_deserializes_events(
            candidate: FunctionInfo,
            seen: set[str] | None = None,
        ) -> bool:
            seen = set() if seen is None else seen
            if candidate.key in seen:
                return False
            seen.add(candidate.key)
            candidate_module = self.modules[candidate.module]
            for child in ast.walk(candidate.node):
                if not isinstance(child, ast.Call):
                    continue
                origin = self.imported_origin(candidate_module, child.func)
                if origin in {
                    "azure.eventgrid.EventGridEvent.from_json",
                    "azure.eventgrid.EventGridEvent.from_dict",
                    "azure.core.messaging.CloudEvent.from_json",
                    "azure.core.messaging.CloudEvent.from_dict",
                }:
                    return True
                nested = local_function(child.func)
                if nested is not None and function_deserializes_events(nested, seen):
                    return True
            return False

        def function_returns_event_type(candidate: FunctionInfo) -> bool:
            candidate_parameters = self.parameter_nodes(candidate)
            if not candidate_parameters:
                return False
            event_name = candidate_parameters[0].arg
            return any(
                isinstance(child, ast.Attribute)
                and child.attr in {"event_type", "type"}
                and isinstance(child.value, ast.Name)
                and child.value.id == event_name
                for child in ast.walk(candidate.node)
            )

        def target_names(target: ast.expr) -> set[str]:
            if isinstance(target, ast.Name):
                return {target.id}
            if isinstance(target, (ast.Tuple, ast.List)):
                return set().union(*(target_names(item) for item in target.elts))
            return set()

        def expression_state(
            node: ast.expr,
            environment: dict[str, state],
        ) -> state:
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                return ("string", node.value)
            if isinstance(node, ast.Name):
                if node.id in environment:
                    return environment[node.id]
                value = module.env.get(node.id)
                if (
                    value is not None
                    and value.kind == "literal"
                    and isinstance(value.data, str)
                ):
                    return ("string", value.data)
                return other
            if isinstance(node, ast.Attribute):
                return (
                    ("event-type", None)
                    if (
                        node.attr in {"event_type", "type"}
                        and expression_state(node.value, environment)[0] == "event"
                    )
                    else other
                )
            if isinstance(node, ast.IfExp):
                left = expression_state(node.body, environment)
                right = expression_state(node.orelse, environment)
                return left if left == right else other
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
                left = expression_state(node.left, environment)
                right = expression_state(node.right, environment)
                if left[0] == right[0] == "string":
                    return ("string", str(left[1]) + str(right[1]))
                return other
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                if (
                    node.func.id == "getattr"
                    and len(node.args) >= 2
                    and expression_state(node.args[0], environment)[0] == "event"
                    and isinstance(node.args[1], ast.Constant)
                    and node.args[1].value in {"event_type", "type"}
                ):
                    return ("event-type", None)
                candidate = local_function(node.func)
                if candidate is not None:
                    if (
                        node.args
                        and expression_state(node.args[0], environment)[0] == "event"
                        and function_returns_event_type(candidate)
                    ):
                        return ("event-type", None)
                    if function_deserializes_events(candidate):
                        return ("event-list", None)
                return other
            return other

        def assign_state(
            target: ast.expr,
            value: state,
            environment: dict[str, state],
        ) -> None:
            names = target_names(target)
            for name in names:
                environment[name] = value if len(names) == 1 else other

        def merge_states(
            left: dict[str, state],
            right: dict[str, state],
        ) -> dict[str, state]:
            return {
                name: (
                    left.get(name, other)
                    if left.get(name, other) == right.get(name, other)
                    else other
                )
                for name in set(left) | set(right)
            }

        def process(
            statements: list[ast.stmt],
            environment: dict[str, state],
        ) -> tuple[dict[str, state], bool]:
            current = dict(environment)
            for statement in statements:
                if isinstance(statement, ast.Assign):
                    value = expression_state(statement.value, current)
                    for target in statement.targets:
                        assign_state(target, value, current)
                elif isinstance(statement, ast.AnnAssign):
                    assign_state(
                        statement.target,
                        expression_state(statement.value, current)
                        if statement.value is not None
                        else other,
                        current,
                    )
                elif isinstance(statement, (ast.AugAssign, ast.NamedExpr)):
                    assign_state(statement.target, other, current)
                elif isinstance(statement, ast.Delete):
                    for target in statement.targets:
                        assign_state(target, other, current)
                elif isinstance(statement, (ast.Import, ast.ImportFrom)):
                    names = (
                        [
                            alias.asname or alias.name.split(".", 1)[0]
                            for alias in statement.names
                        ]
                        if isinstance(statement, ast.Import)
                        else [
                            alias.asname or alias.name
                            for alias in statement.names
                            if alias.name != "*"
                        ]
                    )
                    for name in names:
                        current[name] = other
                elif isinstance(
                    statement, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
                ):
                    current[statement.name] = other
                elif isinstance(statement, ast.If):
                    states[id(statement)] = (
                        {
                            name
                            for name, value in current.items()
                            if value[0] == "event-type"
                        },
                        {
                            name: str(value[1])
                            for name, value in current.items()
                            if value[0] == "string"
                        },
                    )
                    condition = static_literal_truth(statement.test)
                    if condition is True:
                        current, terminated = process(statement.body, current)
                    elif condition is False:
                        current, terminated = process(statement.orelse, current)
                    else:
                        left, left_terminated = process(statement.body, current)
                        right, right_terminated = process(statement.orelse, current)
                        if left_terminated and right_terminated:
                            return merge_states(left, right), True
                        if left_terminated:
                            current, terminated = right, False
                        elif right_terminated:
                            current, terminated = left, False
                        else:
                            current = merge_states(left, right)
                            terminated = False
                    if terminated:
                        return current, True
                elif isinstance(statement, ast.AsyncFor):
                    zero, zero_terminated = process(statement.orelse, current)
                    many = dict(current)
                    assign_state(statement.target, other, many)
                    many, many_terminated = process(statement.body, many)
                    if not many_terminated:
                        many, many_terminated = process(statement.orelse, many)
                    if zero_terminated:
                        current = many
                    elif many_terminated:
                        current = zero
                    else:
                        current = merge_states(zero, many)
                elif isinstance(statement, ast.For):
                    cardinality = static_iterable_cardinality(statement.iter)
                    zero, zero_terminated = process(statement.orelse, current)
                    if cardinality == 0:
                        current = zero
                        if zero_terminated:
                            return current, True
                        continue
                    many = dict(current)
                    iter_state = expression_state(statement.iter, current)
                    assign_state(
                        statement.target,
                        ("event", None) if iter_state[0] == "event-list" else other,
                        many,
                    )
                    many, many_terminated = process(statement.body, many)
                    if not many_terminated:
                        many, many_terminated = process(statement.orelse, many)
                    if cardinality is None:
                        if zero_terminated:
                            current = many
                        elif many_terminated:
                            current = zero
                        else:
                            current = merge_states(zero, many)
                    else:
                        current = many
                    if cardinality is not None and many_terminated:
                        return current, True
                elif isinstance(statement, ast.While):
                    condition = static_literal_truth(statement.test)
                    zero, zero_terminated = process(statement.orelse, current)
                    if condition is False:
                        current = zero
                        if zero_terminated:
                            return current, True
                        continue
                    many, many_terminated = process(statement.body, current)
                    if not many_terminated:
                        many, many_terminated = process(statement.orelse, many)
                    current = many if condition is True else merge_states(zero, many)
                elif isinstance(statement, (ast.With, ast.AsyncWith)):
                    for item in statement.items:
                        if item.optional_vars is not None:
                            assign_state(item.optional_vars, "other", current)
                    current, terminated = process(statement.body, current)
                    if terminated:
                        return current, True
                elif isinstance(statement, (ast.Try, ast.TryStar)):
                    normal, normal_terminated = process(statement.body, current)
                    if not normal_terminated:
                        normal, normal_terminated = process(statement.orelse, normal)
                    branches = [(normal, normal_terminated)]
                    branches.extend(
                        process(handler.body, current) for handler in statement.handlers
                    )
                    continuing = [
                        branch for branch, terminated in branches if not terminated
                    ]
                    if not continuing:
                        return current, True
                    current = continuing[0]
                    for branch in continuing[1:]:
                        current = merge_states(current, branch)
                    current, terminated = process(statement.finalbody, current)
                    if terminated:
                        return current, True
                elif isinstance(statement, ast.Match):
                    subject = static_literal_value(statement.subject)
                    branches: list[dict[str, str]] = []
                    exhaustive = False
                    for case in statement.cases:
                        matches = static_match_pattern(case.pattern, subject)
                        if matches is False:
                            continue
                        branch = dict(current)
                        for name in match_bound_names(case.pattern):
                            branch[name] = other
                        guard = (
                            static_literal_truth(case.guard)
                            if case.guard is not None
                            else True
                        )
                        if guard is False:
                            continue
                        branch, terminated = process(case.body, branch)
                        if not terminated:
                            branches.append(branch)
                        if matches is True and guard is True:
                            exhaustive = True
                            break
                    if not exhaustive:
                        branches.append(dict(current))
                    if not branches:
                        return current, True
                    current = branches[0]
                    for branch in branches[1:]:
                        current = merge_states(current, branch)
                elif isinstance(
                    statement, (ast.Return, ast.Raise, ast.Break, ast.Continue)
                ):
                    return current, True
            return current, False

        process(function.node.body, initial)
        return states

    @staticmethod
    def expression_uses_names(node: ast.expr, names: set[str]) -> bool:
        return any(
            isinstance(child, ast.Name) and child.id in names
            for child in ast.walk(node)
        )

    @staticmethod
    def warning_value_origin(value: Value | None) -> str | None:
        if value is None:
            return None
        if value.kind in {"module", "sdk"}:
            origin = str(value.data)
            if origin.split(".", 1)[0] in TRUSTED_WARNING_ROOTS:
                return origin
        if value.kind == "logger":
            return str(value.data or "logging.Logger-instance")
        return None

    def warning_bindings(
        self,
        function: FunctionInfo,
        module: ModuleInfo,
    ) -> tuple[dict[str, str], set[str]]:
        cached = self.warning_binding_cache.get(function.key)
        if cached is not None:
            return cached

        definitions: dict[str, list[ast.expr | str | None]] = {}
        global_names: set[str] = set()

        def bind(target: ast.expr, value: ast.expr | str | None) -> None:
            if isinstance(target, ast.Name):
                definitions.setdefault(target.id, []).append(value)
            elif isinstance(target, (ast.Tuple, ast.List)):
                for item in target.elts:
                    bind(item, None)

        class BindingCollector(ast.NodeVisitor):
            def visit_Global(self, node: ast.Global) -> None:
                global_names.update(node.names)

            def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
                definitions.setdefault(node.name, []).append(None)

            def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
                definitions.setdefault(node.name, []).append(None)

            def visit_Lambda(self, node: ast.Lambda) -> None:
                return

            def visit_ClassDef(self, node: ast.ClassDef) -> None:
                definitions.setdefault(node.name, []).append(None)

            def visit_Import(self, node: ast.Import) -> None:
                for alias in node.names:
                    bound = alias.asname or alias.name.split(".", 1)[0]
                    origin = alias.name if alias.asname else alias.name.split(".", 1)[0]
                    definitions.setdefault(bound, []).append(
                        origin
                        if (
                            origin.split(".", 1)[0] in TRUSTED_WARNING_ROOTS
                            and not self_analyzer.local_import_shadow(alias.name)
                        )
                        else None
                    )

            def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
                imported_module = node.module or ""
                for alias in node.names:
                    bound = alias.asname or alias.name
                    origin = f"{imported_module}.{alias.name}"
                    definitions.setdefault(bound, []).append(
                        origin
                        if (
                            imported_module.split(".", 1)[0] in TRUSTED_WARNING_ROOTS
                            and not self_analyzer.local_import_shadow(imported_module)
                        )
                        else None
                    )

            def visit_Assign(self, node: ast.Assign) -> None:
                for target in node.targets:
                    bind(target, node.value)
                self.visit(node.value)

            def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
                bind(node.target, node.value)
                if node.value is not None:
                    self.visit(node.value)

            def visit_AugAssign(self, node: ast.AugAssign) -> None:
                bind(node.target, None)
                self.visit(node.value)

            def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
                bind(node.target, node.value)
                self.visit(node.value)

            def visit_For(self, node: ast.For) -> None:
                bind(node.target, None)
                self.visit(node.iter)
                for statement in [*node.body, *node.orelse]:
                    self.visit(statement)

            visit_AsyncFor = visit_For

            def visit_With(self, node: ast.With) -> None:
                for item in node.items:
                    self.visit(item.context_expr)
                    if item.optional_vars is not None:
                        bind(item.optional_vars, None)
                for statement in node.body:
                    self.visit(statement)

            visit_AsyncWith = visit_With

            def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
                if node.name:
                    definitions.setdefault(node.name, []).append(None)
                for statement in node.body:
                    self.visit(statement)

        self_analyzer = self
        for parameter in self.parameter_nodes(function):
            definitions.setdefault(parameter.arg, []).append(None)
        collector = BindingCollector()
        for statement in function.node.body:
            collector.visit(statement)

        for name in global_names:
            definitions.pop(name, None)
        local_names = set(definitions)
        trusted: dict[str, str] = {}

        def resolve(node: ast.expr | str | None) -> str | None:
            if isinstance(node, str):
                return node
            if node is None:
                return None
            if isinstance(node, ast.Name):
                if node.id in local_names:
                    return trusted.get(node.id)
                return self.warning_value_origin(module.env.get(node.id))
            if isinstance(node, ast.Attribute):
                parent = resolve(node.value)
                return f"{parent}.{node.attr}" if parent else None
            if isinstance(node, ast.Call):
                origin = resolve(node.func)
                if origin in {"logging.getLogger", "logging.Logger"}:
                    return "logging.Logger-instance"
            return None

        changed = True
        while changed:
            changed = False
            for name, candidates in definitions.items():
                origins = [resolve(candidate) for candidate in candidates]
                if not origins or any(origin is None for origin in origins):
                    continue
                unique = set(origins)
                if len(unique) != 1:
                    continue
                origin = next(iter(unique))
                if trusted.get(name) != origin:
                    trusted[name] = origin
                    changed = True

        result = trusted, local_names
        self.warning_binding_cache[function.key] = result
        return result

    def trusted_warning_origin(
        self,
        function: FunctionInfo,
        module: ModuleInfo,
        node: ast.expr,
    ) -> str | None:
        trusted, local_names = self.warning_bindings(function, module)

        def resolve(current: ast.expr) -> str | None:
            if isinstance(current, ast.Name):
                if current.id in local_names:
                    return trusted.get(current.id)
                return self.warning_value_origin(module.env.get(current.id))
            if isinstance(current, ast.Attribute):
                parent = resolve(current.value)
                return f"{parent}.{current.attr}" if parent else None
            if isinstance(current, ast.Call):
                origin = resolve(current.func)
                if origin in {"logging.getLogger", "logging.Logger"}:
                    return "logging.Logger-instance"
            return None

        origin = resolve(node)
        if origin and origin.split(".", 1)[0] in self.tainted_warning_roots:
            return None
        return origin

    @staticmethod
    def warning_receiver_name(call: ast.Call) -> str | None:
        if isinstance(call.func, ast.Attribute) and isinstance(
            call.func.value, ast.Name
        ):
            return call.func.value.id
        return None

    def warning_receiver_mutated(
        self,
        module: ModuleInfo,
        receiver_name: str,
        function: FunctionInfo,
    ) -> bool:
        mutated = False
        function_keys = {
            id(candidate.node): candidate.key
            for candidate in (
                *module.functions.values(),
                *(
                    method
                    for class_info in module.classes.values()
                    for method in class_info.methods.values()
                ),
                *self.dynamic_functions.values(),
            )
            if candidate.module == module.name
        }
        active = self.executed | {function.key}

        def inspect_targets(targets: list[ast.expr]) -> None:
            nonlocal mutated
            for target in targets:
                if (
                    isinstance(target, ast.Attribute)
                    and isinstance(target.value, ast.Name)
                    and target.value.id == receiver_name
                    and target.attr
                    in {"error", "exception", "info", "log", "warn", "warning"}
                ):
                    mutated = True

        class MutationVisitor(ast.NodeVisitor):
            def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
                self.visit_function(node)

            def visit_AsyncFunctionDef(
                self,
                node: ast.AsyncFunctionDef,
            ) -> None:
                self.visit_function(node)

            def visit_function(
                self,
                node: ast.FunctionDef | ast.AsyncFunctionDef,
            ) -> None:
                if function_keys.get(id(node)) in active:
                    for statement in node.body:
                        self.visit(statement)

            def visit_Lambda(self, node: ast.Lambda) -> None:
                return

            def visit_ClassDef(self, node: ast.ClassDef) -> None:
                for statement in node.body:
                    self.visit(statement)

            def visit_Assign(self, node: ast.Assign) -> None:
                inspect_targets(node.targets)
                self.generic_visit(node)

            def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
                inspect_targets([node.target])
                self.generic_visit(node)

            def visit_AugAssign(self, node: ast.AugAssign) -> None:
                inspect_targets([node.target])
                self.generic_visit(node)

            def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
                inspect_targets([node.target])
                self.generic_visit(node)

            def visit_Delete(self, node: ast.Delete) -> None:
                inspect_targets(node.targets)
                self.generic_visit(node)

        MutationVisitor().visit(module.tree)
        return mutated

    def standard_warning_call(
        self,
        function: FunctionInfo,
        module: ModuleInfo,
        call: ast.Call,
        *,
        levels: set[str] | None = None,
    ) -> bool:
        levels = {"warn", "warning"} if levels is None else levels
        origin = self.trusted_warning_origin(function, module, call.func)
        if origin == "warnings.warn" and "warn" in levels:
            return True
        if origin == "sys.stderr.write":
            return True
        if (
            origin
            and origin.startswith("logging.Logger-instance.")
            and origin.rsplit(".", 1)[-1] in levels
        ):
            receiver_name = self.warning_receiver_name(call)
            if receiver_name and self.warning_receiver_mutated(
                module,
                receiver_name,
                function,
            ):
                return False
            return True
        if (
            origin
            and origin.startswith("logging.")
            and origin.rsplit(".", 1)[-1] in levels
        ):
            return True
        if isinstance(call.func, ast.Name) and call.func.id == "print":
            return any(
                keyword.arg == "file"
                and self.trusted_warning_origin(function, module, keyword.value)
                == "sys.stderr"
                for keyword in call.keywords
            )
        return False

    def statements_warn(
        self,
        statements: list[ast.stmt],
        module: ModuleInfo,
        function: FunctionInfo,
        seen: set[str] | None = None,
    ) -> bool:
        seen = set() if seen is None else seen

        class ExecutableCallCollector(ast.NodeVisitor):
            def __init__(self) -> None:
                self.calls: list[tuple[ast.Call, bool]] = []
                self.awaited = 0

            def visit_Await(self, node: ast.Await) -> None:
                self.awaited += 1
                self.visit(node.value)
                self.awaited -= 1

            def visit_Call(self, node: ast.Call) -> None:
                self.calls.append((node, self.awaited > 0))
                self.generic_visit(node)

            def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
                return

            def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
                return

            def visit_Lambda(self, node: ast.Lambda) -> None:
                for default in node.args.defaults:
                    self.visit(default)
                for default in node.args.kw_defaults:
                    if default is not None:
                        self.visit(default)

            def visit_ClassDef(self, node: ast.ClassDef) -> None:
                return

        def root_name(node: ast.expr) -> str | None:
            current = node
            while isinstance(current, ast.Attribute):
                current = current.value
            return current.id if isinstance(current, ast.Name) else None

        def direct_calls(node: ast.AST) -> list[tuple[ast.Call, bool]]:
            collector = ExecutableCallCollector()
            collector.visit(node)
            return collector.calls

        def called_warning_helper(
            call: ast.Call,
            awaited: bool,
            helpers: dict[str, Any],
            owner: FunctionInfo,
            shadowed: set[str],
        ) -> bool:
            if root_name(call.func) not in shadowed and self.standard_warning_call(
                owner, module, call
            ):
                return True

            target: FunctionInfo | ast.Lambda | None = None
            if isinstance(call.func, ast.Lambda):
                target = call.func
            elif isinstance(call.func, ast.Name):
                if call.func.id in helpers:
                    target = helpers[call.func.id]
                else:
                    value = module.env.get(call.func.id)
                    if value and value.kind == "function":
                        target = value.data
            elif isinstance(call.func, ast.Attribute):
                class_node = None
                receiver = call.func.value
                if (
                    isinstance(receiver, ast.Call)
                    and isinstance(receiver.func, ast.Name)
                    and isinstance(helpers.get(receiver.func.id), ast.ClassDef)
                ):
                    class_node = helpers[receiver.func.id]
                elif isinstance(receiver, ast.Name):
                    binding = helpers.get(receiver.id)
                    if (
                        isinstance(binding, tuple)
                        and len(binding) == 2
                        and binding[0] == "class-instance"
                    ):
                        class_node = binding[1]
                if class_node is not None:
                    method = next(
                        (
                            child
                            for child in class_node.body
                            if isinstance(
                                child,
                                (ast.FunctionDef, ast.AsyncFunctionDef),
                            )
                            and child.name == call.func.attr
                        ),
                        None,
                    )
                    if method is not None:
                        target = FunctionInfo(
                            key=(
                                f"{owner.key}:<warning-class>."
                                f"{class_node.name}.{method.name}@{method.lineno}"
                            ),
                            module=owner.module,
                            node=method,
                            class_key=class_node.name,
                        )

            if isinstance(target, FunctionInfo):
                if target.is_async and not awaited:
                    return False
                if target.key in seen:
                    return False
                return self.statements_warn(
                    target.node.body,
                    self.modules[target.module],
                    target,
                    seen | {target.key},
                )
            if isinstance(target, ast.Lambda):
                lambda_shadowed = shadowed | {
                    argument.arg
                    for argument in (
                        *target.args.posonlyargs,
                        *target.args.args,
                        *target.args.kwonlyargs,
                    )
                }
                return any(
                    called_warning_helper(
                        nested,
                        nested_awaited,
                        helpers,
                        owner,
                        lambda_shadowed,
                    )
                    for nested, nested_awaited in direct_calls(target.body)
                )
            return False

        def scan_block(
            block: list[ast.stmt],
            owner: FunctionInfo,
            helpers: dict[str, Any],
            shadowed: set[str],
        ) -> bool:
            def decorator_factory_result_warn(
                expression: ast.expr,
            ) -> bool:
                if not isinstance(expression, ast.Call):
                    return False
                target: FunctionInfo | None = None
                if isinstance(expression.func, ast.Name):
                    local = local_helpers.get(expression.func.id)
                    if isinstance(local, FunctionInfo):
                        target = local
                    else:
                        value = module.env.get(expression.func.id)
                        if value and value.kind == "function":
                            target = value.data
                if target is None or target.key in seen:
                    return False

                factory_unknown = object()

                @dataclass(frozen=True, eq=False)
                class FactoryClassValue:
                    node: ast.ClassDef
                    bases: tuple[Any, ...]
                    attrs: dict[str, Any] = field(default_factory=dict)

                @dataclass(frozen=True, eq=False)
                class FactoryInstanceValue:
                    class_value: FactoryClassValue

                target_local_names = function_local_bindings(target.node)

                def literal_expression(value: Any) -> ast.expr:
                    try:
                        return ast.parse(repr(value), mode="eval").body
                    except (SyntaxError, ValueError):
                        return ast.Name(id="__hyoka_unknown", ctx=ast.Load())

                def snapshot_binding(
                    expression: Any,
                    bindings: dict[str, Any],
                    resolving: set[str] | None = None,
                ) -> Any:
                    if isinstance(expression, ast.Name) and expression.id in bindings:
                        resolving = set() if resolving is None else resolving
                        if expression.id in resolving:
                            return factory_unknown
                        return snapshot_binding(
                            bindings[expression.id],
                            bindings,
                            resolving | {expression.id},
                        )
                    return expression

                def safe_factory_binary(
                    operator: ast.operator,
                    left: Any,
                    right: Any,
                ) -> Any:
                    if left is factory_unknown or right is factory_unknown:
                        return factory_unknown
                    numeric = {bool, int, float, complex}
                    try:
                        if isinstance(operator, ast.Add):
                            if type(left) in numeric and type(right) in numeric:
                                return left + right
                            if type(left) is type(right) and type(left) in {
                                str,
                                bytes,
                                tuple,
                                list,
                            }:
                                return left + right
                        elif isinstance(operator, ast.Sub):
                            if type(left) in numeric and type(right) in numeric:
                                return left - right
                        elif isinstance(operator, ast.Mult):
                            if type(left) in numeric and type(right) in numeric:
                                return left * right
                            if (
                                type(left) in {str, bytes, tuple, list}
                                and type(right) is int
                            ):
                                return left * right
                            if (
                                type(right) in {str, bytes, tuple, list}
                                and type(left) is int
                            ):
                                return left * right
                        elif isinstance(operator, ast.Div):
                            if type(left) in numeric and type(right) in numeric:
                                return left / right
                        elif isinstance(operator, ast.FloorDiv):
                            if type(left) in numeric and type(right) in numeric:
                                return left // right
                        elif isinstance(operator, ast.Mod):
                            if type(left) in numeric and type(right) in numeric:
                                return left % right
                        elif isinstance(operator, ast.Pow):
                            if type(left) in numeric and type(right) in numeric:
                                return left**right
                        elif isinstance(operator, ast.LShift):
                            if type(left) is int and type(right) is int:
                                return left << right
                        elif isinstance(operator, ast.RShift):
                            if type(left) is int and type(right) is int:
                                return left >> right
                        elif isinstance(operator, ast.BitOr):
                            if type(left) is int and type(right) is int:
                                return left | right
                        elif isinstance(operator, ast.BitAnd):
                            if type(left) is int and type(right) is int:
                                return left & right
                        elif isinstance(operator, ast.BitXor):
                            if type(left) is int and type(right) is int:
                                return left ^ right
                    except (ArithmeticError, MemoryError, TypeError, ValueError):
                        return factory_unknown
                    return factory_unknown

                def safe_factory_compare(
                    operator: ast.cmpop,
                    left: Any,
                    right: Any,
                ) -> bool | None:
                    if left is factory_unknown or right is factory_unknown:
                        return None
                    if isinstance(operator, ast.Is):
                        return left is right
                    if isinstance(operator, ast.IsNot):
                        return left is not right
                    if isinstance(left, ast.AST) or isinstance(right, ast.AST):
                        return None
                    safe_types = {
                        type(None),
                        bool,
                        int,
                        float,
                        complex,
                        str,
                        bytes,
                        tuple,
                        list,
                        dict,
                        set,
                    }
                    if type(left) not in safe_types or type(right) not in safe_types:
                        return None
                    try:
                        if isinstance(operator, ast.Eq):
                            return left == right
                        if isinstance(operator, ast.NotEq):
                            return left != right
                        if isinstance(operator, ast.Lt):
                            return left < right
                        if isinstance(operator, ast.LtE):
                            return left <= right
                        if isinstance(operator, ast.Gt):
                            return left > right
                        if isinstance(operator, ast.GtE):
                            return left >= right
                        if isinstance(operator, ast.In):
                            return left in right
                        if isinstance(operator, ast.NotIn):
                            return left not in right
                    except (TypeError, ValueError):
                        return None
                    return None

                def static_factory_iterable_items(value: Any) -> list[Any] | None:
                    if isinstance(value, dict):
                        return list(value)
                    if type(value) in {list, tuple, str, bytes}:
                        return list(value)
                    if isinstance(value, set) and len(value) <= 1:
                        return list(value)
                    return None

                def bind_factory_target(
                    target_node: ast.expr,
                    value: Any,
                    bindings: dict[str, Any],
                ) -> None:
                    if isinstance(target_node, ast.Name):
                        bindings[target_node.id] = value
                    elif isinstance(target_node, (ast.Tuple, ast.List)):
                        values = (
                            value.elts
                            if isinstance(value, (ast.Tuple, ast.List))
                            else value
                            if isinstance(value, (tuple, list))
                            else []
                        )
                        for index, item in enumerate(target_node.elts):
                            bind_factory_target(
                                item,
                                (
                                    values[index]
                                    if index < len(values)
                                    else factory_unknown
                                ),
                                bindings,
                            )
                    elif isinstance(target_node, ast.Subscript):
                        assign_factory_item(target_node, value, bindings)
                    else:
                        invalidate_factory_target(target_node, bindings)

                def invalidate_factory_target(
                    target_node: ast.expr,
                    bindings: dict[str, Any],
                ) -> None:
                    if isinstance(target_node, ast.Name):
                        resolved = factory_value(target_node, bindings)
                        if isinstance(resolved, (dict, list, set)):
                            invalidate_factory_aliases(resolved, bindings)
                        elif target_node.id in bindings:
                            bindings[target_node.id] = factory_unknown
                    elif isinstance(target_node, (ast.Tuple, ast.List)):
                        for item in target_node.elts:
                            invalidate_factory_target(item, bindings)
                    elif isinstance(
                        target_node,
                        (ast.Attribute, ast.Starred, ast.Subscript),
                    ):
                        invalidate_factory_target(target_node.value, bindings)

                def merge_factory_bindings(
                    bindings: dict[str, Any],
                    branches: list[dict[str, Any]],
                ) -> None:
                    names = set(bindings).union(*(set(branch) for branch in branches))
                    for name in names:
                        values = [
                            branch.get(name, factory_unknown) for branch in branches
                        ]
                        first = values[0]
                        if all(value is first for value in values[1:]):
                            bindings[name] = first
                            continue
                        try:
                            equal = all(value == first for value in values[1:])
                        except (TypeError, ValueError):
                            equal = False
                        bindings[name] = first if equal else factory_unknown

                def factory_comprehension(
                    expression: (ast.ListComp | ast.SetComp | ast.DictComp),
                    bindings: dict[str, Any],
                ) -> Any:
                    return collapse_factory_outcomes(
                        factory_comprehension_expression_outcomes(
                            expression,
                            bindings,
                        ),
                        bindings,
                    )

                def collapse_factory_outcomes(
                    outcomes: list[tuple[str, dict[str, Any], Any]],
                    bindings: dict[str, Any],
                ) -> Any:
                    if not outcomes:
                        return factory_unknown
                    merge_factory_bindings(
                        bindings,
                        [outcome_bindings for _, outcome_bindings, _ in outcomes],
                    )
                    completed: list[Any] = []
                    for control, _, value in outcomes:
                        if control not in {"normal", "return"}:
                            return factory_unknown
                        completed.append(value)
                    first = completed[0]
                    if all(value is first for value in completed[1:]):
                        return first
                    try:
                        return (
                            first
                            if all(value == first for value in completed[1:])
                            else factory_unknown
                        )
                    except (TypeError, ValueError):
                        return factory_unknown

                def factory_unshadowed_builtin(
                    expression: ast.expr,
                    name: str,
                    bindings: dict[str, Any],
                ) -> bool:
                    return (
                        isinstance(expression, ast.Name)
                        and expression.id == name
                        and name not in bindings
                        and name not in target_local_names
                        and name not in local_helpers
                        and name not in module.env
                    )

                def factory_attribute_value(
                    owner: Any,
                    name: str,
                    bindings: dict[str, Any],
                ) -> Any:
                    if isinstance(owner, FactoryInstanceValue):
                        owner = owner.class_value
                    if not isinstance(owner, FactoryClassValue):
                        return factory_unknown
                    value = owner.attrs.get(name, factory_unknown)
                    if value is factory_unknown:
                        return factory_unknown
                    return factory_value(value, bindings)

                def factory_value(
                    expression: Any,
                    bindings: dict[str, Any],
                    resolving: set[str] | None = None,
                ) -> Any:
                    if expression is factory_unknown or expression is None:
                        return factory_unknown
                    if isinstance(expression, ast.Lambda):
                        if resolving is None:
                            for default in expression.args.defaults:
                                factory_value(default, bindings)
                            for default in expression.args.kw_defaults:
                                if default is not None:
                                    factory_value(default, bindings)
                        return expression
                    if isinstance(
                        expression,
                        (ast.FunctionDef, ast.AsyncFunctionDef),
                    ):
                        return expression
                    if not isinstance(expression, ast.AST):
                        return expression
                    if isinstance(expression, ast.Name):
                        if expression.id not in bindings:
                            return expression
                        resolving = set() if resolving is None else resolving
                        if expression.id in resolving:
                            return factory_unknown
                        return factory_value(
                            bindings[expression.id],
                            bindings,
                            resolving | {expression.id},
                        )
                    if isinstance(expression, ast.Constant):
                        return expression.value
                    if isinstance(expression, ast.Attribute):
                        owner = factory_value(
                            expression.value,
                            bindings,
                            resolving,
                        )
                        resolved = factory_attribute_value(
                            owner,
                            expression.attr,
                            bindings,
                        )
                        return expression if resolved is factory_unknown else resolved
                    if isinstance(expression, ast.Starred):
                        return factory_value(expression.value, bindings, resolving)
                    if isinstance(expression, ast.List):
                        values: list[Any] = []
                        for item in expression.elts:
                            value = factory_value(item, bindings, resolving)
                            if isinstance(item, ast.Starred):
                                expanded = static_factory_iterable_items(value)
                                if expanded is None:
                                    return factory_unknown
                                values.extend(expanded)
                            else:
                                values.append(value)
                        return values
                    if isinstance(expression, ast.Set):
                        values: list[Any] = []
                        for item in expression.elts:
                            value = factory_value(item, bindings, resolving)
                            if isinstance(item, ast.Starred):
                                expanded = static_factory_iterable_items(value)
                                if expanded is None:
                                    return factory_unknown
                                values.extend(expanded)
                            else:
                                values.append(value)
                        if any(item is factory_unknown for item in values):
                            return factory_unknown
                        try:
                            return set(values)
                        except TypeError:
                            return factory_unknown
                    if isinstance(expression, ast.Tuple):
                        values = []
                        for item in expression.elts:
                            value = factory_value(item, bindings, resolving)
                            if isinstance(item, ast.Starred):
                                expanded = static_factory_iterable_items(value)
                                if expanded is None:
                                    return factory_unknown
                                values.extend(expanded)
                            else:
                                values.append(value)
                        return tuple(values)
                    if isinstance(expression, ast.Dict):
                        result: dict[Any, Any] = {}
                        for key_node, value_node in zip(
                            expression.keys,
                            expression.values,
                            strict=True,
                        ):
                            value = factory_value(
                                value_node,
                                bindings,
                                resolving,
                            )
                            if key_node is None:
                                if not isinstance(value, dict):
                                    return factory_unknown
                                result.update(value)
                                continue
                            key = factory_value(
                                key_node,
                                bindings,
                                resolving,
                            )
                            if key is factory_unknown or value is factory_unknown:
                                return factory_unknown
                            try:
                                result[key] = value
                            except TypeError:
                                return factory_unknown
                        return result
                    if isinstance(expression, ast.Subscript):
                        container = factory_value(
                            expression.value,
                            bindings,
                            resolving,
                        )
                        index = factory_value(
                            expression.slice,
                            bindings,
                            resolving,
                        )
                        if (
                            container is factory_unknown
                            or index is factory_unknown
                            or isinstance(container, ast.AST)
                            or isinstance(index, ast.AST)
                        ):
                            return factory_unknown
                        try:
                            if type(container) in {list, tuple, str, bytes, dict}:
                                return container[index]
                        except (IndexError, KeyError, TypeError, ValueError):
                            return factory_unknown
                        return factory_unknown
                    if isinstance(expression, ast.BinOp):
                        return safe_factory_binary(
                            expression.op,
                            factory_value(expression.left, bindings, resolving),
                            factory_value(expression.right, bindings, resolving),
                        )
                    if isinstance(expression, ast.UnaryOp):
                        value = factory_value(
                            expression.operand,
                            bindings,
                            resolving,
                        )
                        if value is factory_unknown or isinstance(value, ast.AST):
                            return expression
                        try:
                            if isinstance(expression.op, ast.Not):
                                return not value
                            if isinstance(expression.op, ast.UAdd):
                                return +value
                            if isinstance(expression.op, ast.USub):
                                return -value
                            if isinstance(expression.op, ast.Invert):
                                return ~value
                        except (ArithmeticError, TypeError, ValueError):
                            return factory_unknown
                        return expression
                    if isinstance(expression, ast.BoolOp):
                        result: Any = factory_unknown
                        for index, item in enumerate(expression.values):
                            result = factory_value(item, bindings, resolving)
                            if result is factory_unknown or isinstance(result, ast.AST):
                                skipped = dict(bindings)
                                executed = dict(bindings)
                                remaining = expression.values[index + 1 :]
                                if remaining:
                                    tail = (
                                        remaining[0]
                                        if len(remaining) == 1
                                        else ast.BoolOp(
                                            op=expression.op,
                                            values=remaining,
                                        )
                                    )
                                    factory_value(tail, executed, resolving)
                                merge_factory_bindings(
                                    bindings,
                                    [skipped, executed],
                                )
                                return expression
                            try:
                                truth = bool(result)
                            except (TypeError, ValueError):
                                return expression
                            if isinstance(expression.op, ast.And) and not truth:
                                return result
                            if isinstance(expression.op, ast.Or) and truth:
                                return result
                        return result
                    if isinstance(expression, ast.IfExp):
                        condition = factory_value(
                            expression.test,
                            bindings,
                            resolving,
                        )
                        if condition is not factory_unknown and not isinstance(
                            condition,
                            ast.AST,
                        ):
                            try:
                                branch = (
                                    expression.body
                                    if bool(condition)
                                    else expression.orelse
                                )
                                return factory_value(branch, bindings, resolving)
                            except (TypeError, ValueError):
                                pass
                        consequent = dict(bindings)
                        alternate = dict(bindings)
                        factory_value(expression.body, consequent, resolving)
                        factory_value(expression.orelse, alternate, resolving)
                        merge_factory_bindings(
                            bindings,
                            [consequent, alternate],
                        )
                        return expression
                    if isinstance(expression, ast.Compare):
                        left = factory_value(
                            expression.left,
                            bindings,
                            resolving,
                        )
                        for index, (operator, comparator) in enumerate(
                            zip(
                                expression.ops,
                                expression.comparators,
                                strict=True,
                            )
                        ):
                            right = factory_value(
                                comparator,
                                bindings,
                                resolving,
                            )
                            comparison = safe_factory_compare(
                                operator,
                                left,
                                right,
                            )
                            if comparison is False:
                                return False
                            if comparison is None:
                                if index + 1 < len(expression.comparators):
                                    skipped = dict(bindings)
                                    continued = dict(bindings)
                                    remaining = ast.Compare(
                                        left=literal_expression(right),
                                        ops=expression.ops[index + 1 :],
                                        comparators=expression.comparators[index + 1 :],
                                    )
                                    factory_value(
                                        remaining,
                                        continued,
                                        resolving,
                                    )
                                    merge_factory_bindings(
                                        bindings,
                                        [skipped, continued],
                                    )
                                return factory_unknown
                            left = right
                        return True
                    if isinstance(expression, ast.JoinedStr):
                        for item in expression.values:
                            factory_value(item, bindings, resolving)
                        return expression
                    if isinstance(expression, ast.FormattedValue):
                        factory_value(expression.value, bindings, resolving)
                        if expression.format_spec is not None:
                            factory_value(
                                expression.format_spec,
                                bindings,
                                resolving,
                            )
                        return expression
                    if isinstance(expression, ast.Slice):
                        for item in (
                            expression.lower,
                            expression.upper,
                            expression.step,
                        ):
                            if item is not None:
                                factory_value(item, bindings, resolving)
                        return expression
                    if isinstance(expression, ast.GeneratorExp):
                        if expression.generators:
                            factory_value(
                                expression.generators[0].iter,
                                bindings,
                                resolving,
                            )
                        return expression
                    if isinstance(
                        expression,
                        (ast.ListComp, ast.SetComp, ast.DictComp),
                    ):
                        return factory_comprehension(expression, bindings)
                    if isinstance(expression, ast.NamedExpr):
                        value = factory_value(
                            expression.value,
                            bindings,
                            resolving,
                        )
                        bind_factory_target(expression.target, value, bindings)
                        return value
                    if isinstance(expression, ast.Call):
                        if factory_unshadowed_builtin(
                            expression.func,
                            "slice",
                            bindings,
                        ):
                            arguments, keyword_values = factory_call_argument_values(
                                expression,
                                bindings,
                            )
                            control, result = factory_slice_call_result(
                                expression,
                                arguments,
                                keyword_values,
                            )
                            return result if control == "normal" else factory_unknown
                        helper_outcomes = factory_helper_outcomes(
                            expression,
                            bindings,
                        )
                        if helper_outcomes is not None:
                            return collapse_factory_outcomes(
                                helper_outcomes,
                                bindings,
                            )
                        handled, result = mutate_factory_call(expression, bindings)
                        return result if handled else expression
                    for _, child in ast.iter_fields(expression):
                        if isinstance(child, ast.expr):
                            factory_value(child, bindings, resolving)
                        elif isinstance(child, (list, tuple)):
                            for item in child:
                                if isinstance(item, ast.expr):
                                    factory_value(item, bindings, resolving)
                    return expression

                def factory_contains_identity(
                    value: Any,
                    target_value: Any,
                    seen_values: set[int] | None = None,
                ) -> bool:
                    if value is target_value:
                        return True
                    if not isinstance(value, (dict, list, set, tuple)):
                        return False
                    seen_values = set() if seen_values is None else seen_values
                    if id(value) in seen_values:
                        return False
                    seen_values.add(id(value))
                    if isinstance(value, dict):
                        children = (*value.keys(), *value.values())
                    else:
                        children = value
                    return any(
                        factory_contains_identity(child, target_value, seen_values)
                        for child in children
                    )

                def static_factory_collection_value(
                    value: Any,
                    bindings: dict[str, Any],
                    resolving: set[str] | None = None,
                ) -> Any:
                    if value is factory_unknown or value is None:
                        return factory_unknown
                    if not isinstance(value, ast.AST):
                        return value
                    if isinstance(value, ast.Name):
                        if value.id not in bindings:
                            return factory_unknown
                        resolving = set() if resolving is None else resolving
                        if value.id in resolving:
                            return factory_unknown
                        return static_factory_collection_value(
                            bindings[value.id],
                            bindings,
                            resolving | {value.id},
                        )
                    if isinstance(value, ast.Constant):
                        return value.value
                    if isinstance(value, ast.Starred):
                        return static_factory_collection_value(
                            value.value,
                            bindings,
                            resolving,
                        )
                    if isinstance(value, (ast.List, ast.Tuple, ast.Set)):
                        items: list[Any] = []
                        for item in value.elts:
                            resolved = static_factory_collection_value(
                                item,
                                bindings,
                                resolving,
                            )
                            if isinstance(item, ast.Starred):
                                expanded = static_factory_iterable_items(resolved)
                                if expanded is None:
                                    return factory_unknown
                                items.extend(expanded)
                            else:
                                items.append(resolved)
                        if isinstance(value, ast.List):
                            return items
                        if isinstance(value, ast.Tuple):
                            return tuple(items)
                        if any(item is factory_unknown for item in items):
                            return factory_unknown
                        try:
                            return set(items)
                        except TypeError:
                            return factory_unknown
                    if isinstance(value, ast.Dict):
                        result: dict[Any, Any] = {}
                        for key_node, value_node in zip(
                            value.keys,
                            value.values,
                            strict=True,
                        ):
                            resolved_value = static_factory_collection_value(
                                value_node,
                                bindings,
                                resolving,
                            )
                            if key_node is None:
                                if not isinstance(resolved_value, dict):
                                    return factory_unknown
                                result.update(resolved_value)
                                continue
                            resolved_key = static_factory_collection_value(
                                key_node,
                                bindings,
                                resolving,
                            )
                            if (
                                resolved_key is factory_unknown
                                or resolved_value is factory_unknown
                            ):
                                return factory_unknown
                            try:
                                result[resolved_key] = resolved_value
                            except TypeError:
                                return factory_unknown
                        return result
                    if isinstance(value, ast.Slice):
                        parts = [
                            (
                                None
                                if part is None
                                else static_factory_collection_value(
                                    part,
                                    bindings,
                                    resolving,
                                )
                            )
                            for part in (value.lower, value.upper, value.step)
                        ]
                        if any(
                            part is factory_unknown or isinstance(part, ast.AST)
                            for part in parts
                        ):
                            return factory_unknown
                        return slice(*parts)
                    if isinstance(value, ast.Subscript):
                        container = static_factory_collection_value(
                            value.value,
                            bindings,
                            resolving,
                        )
                        index = static_factory_collection_value(
                            value.slice,
                            bindings,
                            resolving,
                        )
                        if (
                            container is factory_unknown
                            or index is factory_unknown
                            or isinstance(container, ast.AST)
                            or isinstance(index, ast.AST)
                        ):
                            return factory_unknown
                        try:
                            if type(container) in {
                                list,
                                tuple,
                                str,
                                bytes,
                                dict,
                            }:
                                return container[index]
                        except (IndexError, KeyError, TypeError, ValueError):
                            return factory_unknown
                        return factory_unknown
                    if isinstance(value, ast.BinOp):
                        return safe_factory_binary(
                            value.op,
                            static_factory_collection_value(
                                value.left,
                                bindings,
                                resolving,
                            ),
                            static_factory_collection_value(
                                value.right,
                                bindings,
                                resolving,
                            ),
                        )
                    if isinstance(value, ast.UnaryOp):
                        operand = static_factory_collection_value(
                            value.operand,
                            bindings,
                            resolving,
                        )
                        if operand is factory_unknown or isinstance(
                            operand,
                            ast.AST,
                        ):
                            return factory_unknown
                        try:
                            if isinstance(value.op, ast.Not):
                                return not operand
                            if isinstance(value.op, ast.UAdd):
                                return +operand
                            if isinstance(value.op, ast.USub):
                                return -operand
                            if isinstance(value.op, ast.Invert):
                                return ~operand
                        except (ArithmeticError, TypeError, ValueError):
                            return factory_unknown
                        return factory_unknown
                    if isinstance(value, ast.BoolOp):
                        result: Any = factory_unknown
                        for item in value.values:
                            result = static_factory_collection_value(
                                item,
                                bindings,
                                resolving,
                            )
                            truth = (
                                None
                                if result is factory_unknown
                                or isinstance(result, ast.AST)
                                else bool(result)
                            )
                            if truth is None:
                                return factory_unknown
                            if isinstance(value.op, ast.And) and not truth:
                                return result
                            if isinstance(value.op, ast.Or) and truth:
                                return result
                        return result
                    if isinstance(value, ast.IfExp):
                        condition = static_factory_collection_value(
                            value.test,
                            bindings,
                            resolving,
                        )
                        if condition is factory_unknown or isinstance(
                            condition,
                            ast.AST,
                        ):
                            return factory_unknown
                        try:
                            selected = value.body if bool(condition) else value.orelse
                        except (TypeError, ValueError):
                            return factory_unknown
                        return static_factory_collection_value(
                            selected,
                            bindings,
                            resolving,
                        )
                    if isinstance(value, ast.Compare):
                        left = static_factory_collection_value(
                            value.left,
                            bindings,
                            resolving,
                        )
                        for operator, comparator in zip(
                            value.ops,
                            value.comparators,
                            strict=True,
                        ):
                            right = static_factory_collection_value(
                                comparator,
                                bindings,
                                resolving,
                            )
                            comparison = safe_factory_compare(
                                operator,
                                left,
                                right,
                            )
                            if comparison is not True:
                                return (
                                    comparison
                                    if comparison is False
                                    else factory_unknown
                                )
                            left = right
                        return True
                    if isinstance(value, ast.NamedExpr):
                        return static_factory_collection_value(
                            value.value,
                            bindings,
                            resolving,
                        )
                    return factory_unknown

                def static_factory_collection_truth(
                    value: Any,
                    bindings: dict[str, Any],
                    resolving: set[str] | None = None,
                ) -> bool | None:
                    resolved = static_factory_collection_value(
                        value,
                        bindings,
                        resolving,
                    )
                    if resolved is factory_unknown or isinstance(resolved, ast.AST):
                        return None
                    try:
                        return bool(resolved)
                    except (TypeError, ValueError):
                        return None

                def collect_factory_mutable_values(
                    value: Any,
                    bindings: dict[str, Any],
                    collected: dict[int, Any] | None = None,
                    seen_values: set[int] | None = None,
                    resolving: set[str] | None = None,
                ) -> dict[int, Any]:
                    collected = {} if collected is None else collected
                    seen_values = set() if seen_values is None else seen_values
                    resolving = set() if resolving is None else resolving
                    if value is factory_unknown or value is None:
                        return collected
                    if isinstance(value, ast.Name):
                        if value.id in bindings and value.id not in resolving:
                            collect_factory_mutable_values(
                                bindings[value.id],
                                bindings,
                                collected,
                                seen_values,
                                resolving | {value.id},
                            )
                        return collected
                    if isinstance(value, ast.Lambda):
                        for default in value.args.defaults:
                            collect_factory_mutable_values(
                                default,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        for default in value.args.kw_defaults:
                            if default is not None:
                                collect_factory_mutable_values(
                                    default,
                                    bindings,
                                    collected,
                                    seen_values,
                                    resolving,
                                )
                        return collected
                    if isinstance(value, (ast.Attribute, ast.Starred)):
                        return collect_factory_mutable_values(
                            value.value,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                    if isinstance(value, ast.IfExp):
                        collect_factory_mutable_values(
                            value.test,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                        condition = static_factory_collection_truth(
                            value.test,
                            bindings,
                            resolving,
                        )
                        branches = (
                            (value.body,)
                            if condition is True
                            else (value.orelse,)
                            if condition is False
                            else (value.body, value.orelse)
                        )
                        for branch in branches:
                            collect_factory_mutable_values(
                                branch,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        return collected
                    if isinstance(value, ast.BoolOp):
                        for item in value.values:
                            collect_factory_mutable_values(
                                item,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                            truth = static_factory_collection_truth(
                                item,
                                bindings,
                                resolving,
                            )
                            if isinstance(value.op, ast.And) and truth is False:
                                break
                            if isinstance(value.op, ast.Or) and truth is True:
                                break
                        return collected
                    if isinstance(value, ast.BinOp):
                        for item in (value.left, value.right):
                            collect_factory_mutable_values(
                                item,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        return collected
                    if isinstance(value, ast.UnaryOp):
                        return collect_factory_mutable_values(
                            value.operand,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                    if isinstance(value, ast.Compare):
                        collect_factory_mutable_values(
                            value.left,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                        left = static_factory_collection_value(
                            value.left,
                            bindings,
                            resolving,
                        )
                        for operator, comparator in zip(
                            value.ops,
                            value.comparators,
                            strict=True,
                        ):
                            collect_factory_mutable_values(
                                comparator,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                            right = static_factory_collection_value(
                                comparator,
                                bindings,
                                resolving,
                            )
                            comparison = safe_factory_compare(
                                operator,
                                left,
                                right,
                            )
                            if comparison is False:
                                break
                            left = right
                        return collected
                    if isinstance(value, ast.JoinedStr):
                        for item in value.values:
                            collect_factory_mutable_values(
                                item,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        return collected
                    if isinstance(value, ast.FormattedValue):
                        collect_factory_mutable_values(
                            value.value,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                        if value.format_spec is not None:
                            collect_factory_mutable_values(
                                value.format_spec,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        return collected
                    if isinstance(value, ast.Slice):
                        for item in (value.lower, value.upper, value.step):
                            if item is not None:
                                collect_factory_mutable_values(
                                    item,
                                    bindings,
                                    collected,
                                    seen_values,
                                    resolving,
                                )
                        return collected
                    if isinstance(value, ast.Subscript):
                        collect_factory_mutable_values(
                            value.value,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                        collect_factory_mutable_values(
                            value.slice,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                        return collected
                    if isinstance(value, ast.Dict):
                        for key, item in zip(
                            value.keys,
                            value.values,
                            strict=True,
                        ):
                            collect_factory_mutable_values(
                                key,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                            collect_factory_mutable_values(
                                item,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        return collected
                    if isinstance(value, (ast.List, ast.Set, ast.Tuple)):
                        for item in value.elts:
                            collect_factory_mutable_values(
                                item,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        return collected
                    if isinstance(
                        value,
                        (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp),
                    ):
                        if id(value) in seen_values:
                            return collected
                        seen_values.add(id(value))
                        for generator in value.generators:
                            collect_factory_mutable_values(
                                generator.iter,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                            for condition in generator.ifs:
                                collect_factory_mutable_values(
                                    condition,
                                    bindings,
                                    collected,
                                    seen_values,
                                    resolving,
                                )
                        result_expressions = (
                            (value.key, value.value)
                            if isinstance(value, ast.DictComp)
                            else (value.elt,)
                        )
                        for result_expression in result_expressions:
                            collect_factory_mutable_values(
                                result_expression,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        materialized = (
                            ast.ListComp(
                                elt=value.elt,
                                generators=value.generators,
                            )
                            if isinstance(value, ast.GeneratorExp)
                            else value
                        )
                        for control, current, result in (
                            factory_comprehension_expression_outcomes(
                                materialized,
                                dict(bindings),
                            )
                        ):
                            if control == "normal":
                                collect_factory_mutable_values(
                                    result,
                                    current,
                                    collected,
                                    seen_values,
                                    resolving,
                                )
                        return collected
                    if isinstance(value, ast.Call):
                        ordered = [
                            value.func,
                            *value.args,
                            *(keyword.value for keyword in value.keywords),
                        ]
                        ordered.sort(
                            key=lambda item: (
                                getattr(item, "lineno", -1),
                                getattr(item, "col_offset", -1),
                            )
                        )
                        for item in ordered:
                            collect_factory_mutable_values(
                                item,
                                bindings,
                                collected,
                                seen_values,
                                resolving,
                            )
                        return collected
                    if isinstance(value, ast.NamedExpr):
                        return collect_factory_mutable_values(
                            value.value,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                    if isinstance(value, ast.AST):
                        for _, child in ast.iter_fields(value):
                            if isinstance(child, ast.expr):
                                collect_factory_mutable_values(
                                    child,
                                    bindings,
                                    collected,
                                    seen_values,
                                    resolving,
                                )
                            elif isinstance(child, (list, tuple)):
                                for item in child:
                                    if isinstance(item, ast.expr):
                                        collect_factory_mutable_values(
                                            item,
                                            bindings,
                                            collected,
                                            seen_values,
                                            resolving,
                                        )
                        return collected
                    if not isinstance(value, (dict, list, set, tuple)):
                        return collected
                    if id(value) in seen_values:
                        return collected
                    seen_values.add(id(value))
                    if isinstance(value, (dict, list, set)):
                        collected[id(value)] = value
                    children = (
                        (*value.keys(), *value.values())
                        if isinstance(value, dict)
                        else value
                    )
                    for child in children:
                        collect_factory_mutable_values(
                            child,
                            bindings,
                            collected,
                            seen_values,
                            resolving,
                        )
                    return collected

                def invalidate_factory_values(
                    values: list[Any] | tuple[Any, ...],
                    bindings: dict[str, Any],
                ) -> None:
                    targets: dict[int, Any] = {}
                    for value in values:
                        collect_factory_mutable_values(
                            value,
                            bindings,
                            targets,
                        )
                    if not targets:
                        return
                    original = dict(bindings)
                    invalidated: list[str] = []
                    for name, bound in original.items():
                        resolved = factory_value(
                            bound,
                            dict(original),
                            set(),
                        )
                        if any(
                            factory_contains_identity(resolved, target)
                            for target in targets.values()
                        ):
                            invalidated.append(name)
                    for name in invalidated:
                        bindings[name] = factory_unknown

                def invalidate_factory_call_values(
                    call: ast.Call,
                    arguments: list[Any],
                    keyword_values: list[tuple[str | None, Any]],
                    bindings: dict[str, Any],
                ) -> None:
                    values: list[Any] = [call.func]
                    for expression, value in zip(
                        call.args,
                        arguments,
                        strict=True,
                    ):
                        values.append(value)
                        if value is factory_unknown or isinstance(value, ast.expr):
                            values.append(expression)
                    for keyword, (_, value) in zip(
                        call.keywords,
                        keyword_values,
                        strict=True,
                    ):
                        values.append(value)
                        if value is factory_unknown or isinstance(value, ast.expr):
                            values.append(keyword.value)
                    invalidate_factory_values(
                        values,
                        bindings,
                    )

                def replace_factory_identity(
                    value: Any,
                    target_value: Any,
                    replacement: Any,
                    replacements: dict[int, Any],
                ) -> tuple[Any, bool]:
                    if value is target_value:
                        return replacement, True
                    if not isinstance(value, (dict, list, set, tuple)):
                        return value, False
                    if id(value) in replacements:
                        replaced = replacements[id(value)]
                        return replaced, replaced is not value
                    if isinstance(value, list):
                        replaced_items = [
                            replace_factory_identity(
                                item,
                                target_value,
                                replacement,
                                replacements,
                            )
                            for item in value
                        ]
                        changed = any(changed for _, changed in replaced_items)
                        replaced = (
                            [item for item, _ in replaced_items] if changed else value
                        )
                    elif isinstance(value, tuple):
                        replaced_items = [
                            replace_factory_identity(
                                item,
                                target_value,
                                replacement,
                                replacements,
                            )
                            for item in value
                        ]
                        changed = any(changed for _, changed in replaced_items)
                        replaced = (
                            tuple(item for item, _ in replaced_items)
                            if changed
                            else value
                        )
                    elif isinstance(value, dict):
                        replaced_items = {
                            key: replace_factory_identity(
                                item,
                                target_value,
                                replacement,
                                replacements,
                            )
                            for key, item in value.items()
                        }
                        changed = any(
                            item_changed for _, item_changed in replaced_items.values()
                        )
                        replaced = (
                            {key: item for key, (item, _) in replaced_items.items()}
                            if changed
                            else value
                        )
                    else:
                        replaced_items = [
                            replace_factory_identity(
                                item,
                                target_value,
                                replacement,
                                replacements,
                            )
                            for item in value
                        ]
                        changed = any(changed for _, changed in replaced_items)
                        try:
                            replaced = (
                                {item for item, _ in replaced_items}
                                if changed
                                else value
                            )
                        except TypeError:
                            return factory_unknown, True
                    replacements[id(value)] = replaced
                    return replaced, changed

                def rebind_factory_aliases(
                    target_value: dict[Any, Any] | list[Any] | set[Any],
                    replacement: Any,
                    bindings: dict[str, Any],
                ) -> None:
                    replacements: dict[int, Any] = {}
                    updates: dict[str, Any] = {}
                    for name, bound in list(bindings.items()):
                        resolved = factory_value(bound, bindings, set())
                        replaced, changed = replace_factory_identity(
                            resolved,
                            target_value,
                            replacement,
                            replacements,
                        )
                        if changed:
                            updates[name] = replaced
                    bindings.update(updates)

                def invalidate_factory_aliases(
                    target_value: dict[Any, Any] | list[Any] | set[Any],
                    bindings: dict[str, Any],
                ) -> None:
                    for name, bound in list(bindings.items()):
                        resolved = factory_value(bound, bindings, set())
                        if factory_contains_identity(resolved, target_value):
                            bindings[name] = factory_unknown

                def assign_factory_item(
                    target_node: ast.Subscript,
                    value: Any,
                    bindings: dict[str, Any],
                ) -> None:
                    container = factory_value(target_node.value, bindings)
                    index = factory_value(target_node.slice, bindings)
                    if not isinstance(container, (dict, list)):
                        invalidate_factory_target(target_node.value, bindings)
                        return
                    updated = container.copy()
                    try:
                        if isinstance(updated, list):
                            if type(index) not in {int, slice}:
                                raise TypeError
                            updated[index] = value
                        else:
                            if isinstance(index, ast.AST) or index is factory_unknown:
                                raise TypeError
                            updated[index] = value
                    except (IndexError, KeyError, TypeError, ValueError):
                        invalidate_factory_aliases(container, bindings)
                        return
                    rebind_factory_aliases(container, updated, bindings)

                def factory_call_argument_values(
                    call: ast.Call,
                    bindings: dict[str, Any],
                ) -> tuple[list[Any], list[tuple[str | None, Any]]]:
                    ordered = [
                        (argument, "argument", index)
                        for index, argument in enumerate(call.args)
                    ] + [
                        (keyword.value, "keyword", index)
                        for index, keyword in enumerate(call.keywords)
                    ]
                    ordered.sort(
                        key=lambda item: (
                            getattr(item[0], "lineno", -1),
                            getattr(item[0], "col_offset", -1),
                        )
                    )
                    positional: list[Any] = [factory_unknown] * len(call.args)
                    keywords: list[tuple[str | None, Any]] = [
                        (keyword.arg, factory_unknown) for keyword in call.keywords
                    ]
                    tracked: list[tuple[str, str, int]] = []
                    for expression, kind, index in ordered:
                        value = factory_value(expression, bindings)
                        if isinstance(value, (dict, list, set, tuple)):
                            marker = (
                                f"\0factory-call-argument-{id(call)}-{kind}-{index}"
                            )
                            bindings[marker] = value
                            tracked.append((marker, kind, index))
                        if kind == "argument":
                            positional[index] = value
                        else:
                            keywords[index] = (call.keywords[index].arg, value)
                    for marker, kind, index in tracked:
                        value = bindings.pop(marker, factory_unknown)
                        if kind == "argument":
                            positional[index] = value
                        else:
                            keywords[index] = (call.keywords[index].arg, value)
                    return positional, keywords

                def factory_call_argument_outcomes(
                    call: ast.Call,
                    bindings: dict[str, Any],
                ) -> list[
                    tuple[
                        str,
                        dict[str, Any],
                        Any,
                        list[Any],
                        list[tuple[str | None, Any]],
                    ]
                ]:
                    active = [
                        (
                            dict(bindings),
                            [factory_unknown] * len(call.args),
                            [
                                (keyword.arg, factory_unknown)
                                for keyword in call.keywords
                            ],
                        )
                    ]
                    outcomes: list[
                        tuple[
                            str,
                            dict[str, Any],
                            Any,
                            list[Any],
                            list[tuple[str | None, Any]],
                        ]
                    ] = []
                    ordered = [
                        (argument, "argument", index)
                        for index, argument in enumerate(call.args)
                    ] + [
                        (keyword.value, "keyword", index)
                        for index, keyword in enumerate(call.keywords)
                    ]
                    ordered.sort(
                        key=lambda item: (
                            getattr(item[0], "lineno", -1),
                            getattr(item[0], "col_offset", -1),
                        )
                    )
                    for expression, kind, index in ordered:
                        following: list[
                            tuple[
                                dict[str, Any],
                                list[Any],
                                list[tuple[str | None, Any]],
                            ]
                        ] = []
                        for current, positional, keywords in active:
                            for (
                                control,
                                evaluated,
                                value,
                            ) in factory_expression_outcomes(
                                expression,
                                current,
                            ):
                                if control != "normal":
                                    outcomes.append(
                                        (
                                            control,
                                            evaluated,
                                            value,
                                            positional,
                                            keywords,
                                        )
                                    )
                                    continue
                                next_positional = list(positional)
                                next_keywords = list(keywords)
                                if kind == "argument":
                                    next_positional[index] = value
                                else:
                                    next_keywords[index] = (
                                        call.keywords[index].arg,
                                        value,
                                    )
                                if isinstance(value, (dict, list, set, tuple)):
                                    marker = (
                                        "\0factory-call-argument-"
                                        f"{id(call)}-{kind}-{index}"
                                    )
                                    evaluated[marker] = value
                                following.append(
                                    (
                                        evaluated,
                                        next_positional,
                                        next_keywords,
                                    )
                                )
                        active = following

                    for current, positional, keywords in active:
                        for index, argument in enumerate(call.args):
                            marker = (
                                f"\0factory-call-argument-{id(call)}-argument-{index}"
                            )
                            if marker in current:
                                positional[index] = current.pop(marker)
                        for index, keyword in enumerate(call.keywords):
                            marker = (
                                f"\0factory-call-argument-{id(call)}-keyword-{index}"
                            )
                            if marker in current:
                                keywords[index] = (
                                    keyword.arg,
                                    current.pop(marker),
                                )
                        outcomes.append(
                            (
                                "normal",
                                current,
                                None,
                                positional,
                                keywords,
                            )
                        )
                    return outcomes

                def resolve_factory_call_arguments(
                    call: ast.Call,
                    argument_values: list[Any],
                    keyword_values: list[tuple[str | None, Any]],
                ) -> tuple[list[Any], list[tuple[str, Any]]] | None:
                    positional: list[Any] = []
                    for argument, value in zip(
                        call.args,
                        argument_values,
                        strict=True,
                    ):
                        if not isinstance(argument, ast.Starred):
                            positional.append(value)
                            continue
                        expanded = static_factory_iterable_items(value)
                        if expanded is None:
                            return None
                        positional.extend(expanded)

                    keywords: list[tuple[str, Any]] = []
                    seen: set[str] = set()
                    for (name, value), keyword in zip(
                        keyword_values,
                        call.keywords,
                        strict=True,
                    ):
                        if keyword.arg is not None:
                            if keyword.arg in seen:
                                return None
                            seen.add(keyword.arg)
                            keywords.append((keyword.arg, value))
                            continue
                        if not isinstance(value, dict) or not all(
                            isinstance(key, str) for key in value
                        ):
                            return None
                        for key, item in value.items():
                            if key in seen:
                                return None
                            seen.add(key)
                            keywords.append((key, item))
                    return positional, keywords

                def factory_slice_call_result(
                    call: ast.Call,
                    argument_values: list[Any],
                    keyword_values: list[tuple[str | None, Any]],
                ) -> tuple[str, Any]:
                    resolved = resolve_factory_call_arguments(
                        call,
                        argument_values,
                        keyword_values,
                    )
                    if resolved is None:
                        return "normal", factory_unknown
                    positional, keywords = resolved
                    if keywords or not 1 <= len(positional) <= 3:
                        return "raise", "TypeError"
                    if any(
                        value is factory_unknown or isinstance(value, ast.AST)
                        for value in positional
                    ):
                        return "normal", factory_unknown
                    try:
                        return "normal", slice(*positional)
                    except TypeError:
                        return "raise", "TypeError"

                def apply_factory_mutation(
                    method: str,
                    container: dict[Any, Any] | list[Any] | set[Any],
                    arguments: list[Any],
                    keyword_values: list[tuple[str | None, Any]],
                    bindings: dict[str, Any],
                ) -> Any:
                    if any(name is None for name, _ in keyword_values):
                        invalidate_factory_aliases(container, bindings)
                        return factory_unknown
                    keywords = {
                        name: value
                        for name, value in keyword_values
                        if name is not None
                    }
                    if any(
                        factory_contains_identity(argument, container)
                        and not (
                            argument is container
                            and (
                                (
                                    isinstance(container, set)
                                    and method
                                    in {
                                        "difference_update",
                                        "intersection_update",
                                        "symmetric_difference_update",
                                        "update",
                                    }
                                )
                                or (isinstance(container, list) and method == "extend")
                                or (isinstance(container, dict) and method == "update")
                            )
                        )
                        for argument in (*arguments, *keywords.values())
                    ):
                        invalidate_factory_aliases(container, bindings)
                        return factory_unknown
                    updated = container.copy()
                    result: Any = None
                    try:
                        if isinstance(updated, list):
                            if method == "append" and len(arguments) == 1:
                                updated.append(arguments[0])
                            elif method == "clear" and not arguments:
                                updated.clear()
                            elif method == "extend" and len(arguments) == 1:
                                updated.extend(arguments[0])
                            elif method == "insert" and len(arguments) == 2:
                                if type(arguments[0]) is not int:
                                    raise TypeError
                                updated.insert(arguments[0], arguments[1])
                            elif method == "pop" and len(arguments) <= 1:
                                index = arguments[0] if arguments else -1
                                if type(index) is not int:
                                    raise TypeError
                                result = updated.pop(index)
                            elif method == "remove" and len(arguments) == 1:
                                updated.remove(arguments[0])
                            elif method == "reverse" and not arguments:
                                updated.reverse()
                            elif method == "sort" and not arguments and not keywords:
                                updated.sort()
                            else:
                                raise TypeError
                        elif isinstance(updated, dict):
                            if method == "clear" and not arguments:
                                updated.clear()
                            elif method == "pop" and 1 <= len(arguments) <= 2:
                                result = updated.pop(*arguments)
                            elif method == "popitem" and not arguments:
                                result = updated.popitem()
                            elif method == "setdefault" and 1 <= len(arguments) <= 2:
                                result = updated.setdefault(*arguments)
                            elif method == "update" and len(arguments) <= 1:
                                updated.update(*arguments, **keywords)
                            else:
                                raise TypeError
                        elif keywords:
                            raise TypeError
                        elif method == "add" and len(arguments) == 1:
                            updated.add(arguments[0])
                        elif method == "clear" and not arguments:
                            updated.clear()
                        elif method in {
                            "difference_update",
                            "intersection_update",
                            "update",
                        }:
                            getattr(updated, method)(*arguments)
                        elif (
                            method == "symmetric_difference_update"
                            and len(arguments) == 1
                        ):
                            updated.symmetric_difference_update(arguments[0])
                        elif method in {"discard", "remove"} and len(arguments) == 1:
                            getattr(updated, method)(arguments[0])
                        elif method == "pop" and not arguments:
                            result = updated.pop()
                        else:
                            raise TypeError
                    except (
                        AttributeError,
                        IndexError,
                        KeyError,
                        TypeError,
                        ValueError,
                    ):
                        invalidate_factory_aliases(container, bindings)
                        return factory_unknown
                    rebind_factory_aliases(container, updated, bindings)
                    return result

                def path_sensitive_mutate_factory_call(
                    call: ast.Call,
                    bindings: dict[str, Any],
                ) -> list[tuple[str, dict[str, Any], Any]] | None:
                    if (
                        not isinstance(call.func, ast.Attribute)
                        or call.func.attr not in factory_mutating_methods
                    ):
                        return None
                    method = call.func.attr
                    receiver_outcomes = factory_expression_outcomes(
                        call.func.value,
                        dict(bindings),
                    )
                    active: list[
                        tuple[
                            dict[str, Any],
                            list[Any],
                            list[tuple[str | None, Any]],
                        ]
                    ] = []
                    outcomes: list[tuple[str, dict[str, Any], Any]] = []
                    receiver_marker = f"\0factory-call-receiver-{id(call)}"
                    for control, current, container in receiver_outcomes:
                        if control != "normal":
                            outcomes.append((control, current, container))
                            continue
                        if not isinstance(container, (dict, list, set)):
                            invalidate_factory_target(call.func.value, current)
                            outcomes.append(("normal", current, factory_unknown))
                            continue
                        current[receiver_marker] = container
                        active.append(
                            (
                                current,
                                [factory_unknown] * len(call.args),
                                [
                                    (keyword.arg, factory_unknown)
                                    for keyword in call.keywords
                                ],
                            )
                        )

                    ordered = [
                        (argument, "argument", index)
                        for index, argument in enumerate(call.args)
                    ] + [
                        (keyword.value, "keyword", index)
                        for index, keyword in enumerate(call.keywords)
                    ]
                    ordered.sort(
                        key=lambda item: (
                            getattr(item[0], "lineno", -1),
                            getattr(item[0], "col_offset", -1),
                        )
                    )
                    for expression, kind, index in ordered:
                        following: list[
                            tuple[
                                dict[str, Any],
                                list[Any],
                                list[tuple[str | None, Any]],
                            ]
                        ] = []
                        for current, positional, keywords in active:
                            for (
                                control,
                                evaluated,
                                value,
                            ) in factory_expression_outcomes(
                                expression,
                                current,
                            ):
                                if control != "normal":
                                    outcomes.append((control, evaluated, value))
                                    continue
                                next_positional = list(positional)
                                next_keywords = list(keywords)
                                if kind == "argument":
                                    next_positional[index] = value
                                else:
                                    next_keywords[index] = (
                                        call.keywords[index].arg,
                                        value,
                                    )
                                if isinstance(value, (dict, list, set, tuple)):
                                    marker = (
                                        "\0factory-call-argument-"
                                        f"{id(call)}-{kind}-{index}"
                                    )
                                    evaluated[marker] = value
                                following.append(
                                    (
                                        evaluated,
                                        next_positional,
                                        next_keywords,
                                    )
                                )
                        active = following

                    for current, positional, keywords in active:
                        container = current.pop(
                            receiver_marker,
                            factory_unknown,
                        )
                        for index, argument in enumerate(call.args):
                            marker = (
                                f"\0factory-call-argument-{id(call)}-argument-{index}"
                            )
                            if marker in current:
                                positional[index] = current.pop(marker)
                        for index, keyword in enumerate(call.keywords):
                            marker = (
                                f"\0factory-call-argument-{id(call)}-keyword-{index}"
                            )
                            if marker in current:
                                keywords[index] = (
                                    keyword.arg,
                                    current.pop(marker),
                                )
                        if not isinstance(container, (dict, list, set)):
                            outcomes.append(("normal", current, factory_unknown))
                            continue
                        resolved = resolve_factory_call_arguments(
                            call,
                            positional,
                            keywords,
                        )
                        if resolved is None:
                            invalidate_factory_call_values(
                                call,
                                positional,
                                keywords,
                                current,
                            )
                            invalidate_factory_aliases(
                                container,
                                current,
                            )
                            outcomes.append(("normal", current, factory_unknown))
                            continue
                        resolved_positional, resolved_keywords = resolved
                        outcomes.append(
                            (
                                "normal",
                                current,
                                apply_factory_mutation(
                                    method,
                                    container,
                                    resolved_positional,
                                    resolved_keywords,
                                    current,
                                ),
                            )
                        )
                    return outcomes

                def mutate_factory_call(
                    call: ast.Call,
                    bindings: dict[str, Any],
                ) -> tuple[bool, Any]:
                    if isinstance(call.func, ast.Attribute):
                        method = call.func.attr
                        container = factory_value(call.func.value, bindings)
                    else:
                        method = None
                        container = factory_value(call.func, bindings)
                    receiver_marker: str | None = None
                    if method in factory_mutating_methods and isinstance(
                        container, (dict, list, set)
                    ):
                        receiver_marker = f"\0factory-call-receiver-{id(call)}"
                        bindings[receiver_marker] = container
                    arguments, keyword_values = factory_call_argument_values(
                        call,
                        bindings,
                    )
                    if receiver_marker is not None:
                        container = bindings.pop(receiver_marker, factory_unknown)
                    if method not in factory_mutating_methods:
                        invalidate_factory_call_values(
                            call,
                            arguments,
                            keyword_values,
                            bindings,
                        )
                        return False, factory_unknown
                    if not isinstance(container, (dict, list, set)):
                        invalidate_factory_target(call.func.value, bindings)
                        return True, factory_unknown
                    resolved = resolve_factory_call_arguments(
                        call,
                        arguments,
                        keyword_values,
                    )
                    if resolved is None:
                        invalidate_factory_call_values(
                            call,
                            arguments,
                            keyword_values,
                            bindings,
                        )
                        invalidate_factory_aliases(container, bindings)
                        return True, factory_unknown
                    arguments, resolved_keywords = resolved
                    return True, apply_factory_mutation(
                        method,
                        container,
                        arguments,
                        resolved_keywords,
                        bindings,
                    )

                factory_mutating_methods = {
                    "add",
                    "append",
                    "clear",
                    "difference_update",
                    "discard",
                    "extend",
                    "insert",
                    "intersection_update",
                    "pop",
                    "popitem",
                    "remove",
                    "reverse",
                    "setdefault",
                    "sort",
                    "symmetric_difference_update",
                    "update",
                }

                def resolved_factory_expression(
                    expression: ast.expr,
                    bindings: dict[str, Any],
                ) -> ast.expr:
                    class BindingResolver(ast.NodeTransformer):
                        def visit_Name(self, node: ast.Name) -> ast.expr:
                            resolved_name = snapshot_binding(node, bindings)
                            if isinstance(resolved_name, ast.expr):
                                return copy.deepcopy(resolved_name)
                            literal_node = literal_expression(resolved_name)
                            if (
                                isinstance(literal_node, ast.Name)
                                and literal_node.id == "__hyoka_unknown"
                            ):
                                return node
                            return literal_node

                    return BindingResolver().visit(copy.deepcopy(expression))

                def factory_literal(
                    expression: ast.expr,
                    bindings: dict[str, Any],
                ) -> Any:
                    value = factory_value(expression, bindings)
                    if value is factory_unknown:
                        return _UNKNOWN_LITERAL
                    if not isinstance(value, ast.AST):
                        return value
                    return static_literal_value(
                        resolved_factory_expression(value, bindings)
                    )

                def factory_truth(
                    expression: ast.expr,
                    bindings: dict[str, Any],
                ) -> bool | None:
                    value = factory_literal(expression, bindings)
                    if value is not _UNKNOWN_LITERAL:
                        try:
                            return bool(value)
                        except (TypeError, ValueError):
                            return None
                    return static_literal_truth(
                        resolved_factory_expression(expression, bindings)
                    )

                factory_call_stack: set[int] = set()

                def bind_factory_helper_arguments(
                    helper: ast.FunctionDef,
                    call: ast.Call,
                    argument_values: list[Any],
                    keyword_values: list[tuple[str | None, Any]],
                    bindings: dict[str, Any],
                ) -> dict[str, Any] | None:
                    resolved = resolve_factory_call_arguments(
                        call,
                        argument_values,
                        keyword_values,
                    )
                    if resolved is None:
                        return None
                    positional_values, keywords = resolved
                    positional_parameters = [
                        *helper.args.posonlyargs,
                        *helper.args.args,
                    ]
                    if (
                        len(positional_values) > len(positional_parameters)
                        and helper.args.vararg is None
                    ):
                        return None

                    bound: dict[str, Any] = {}
                    for parameter, value in zip(
                        positional_parameters,
                        positional_values,
                    ):
                        bound[parameter.arg] = value

                    regular_names = {parameter.arg for parameter in helper.args.args}
                    keyword_only_names = {
                        parameter.arg for parameter in helper.args.kwonlyargs
                    }
                    extra_keywords: dict[str, Any] = {}
                    for name, value in keywords:
                        if name in regular_names or name in keyword_only_names:
                            if name in bound:
                                return None
                            bound[name] = value
                        else:
                            if helper.args.kwarg is None:
                                return None
                            extra_keywords[name] = value

                    defaults_start = len(positional_parameters) - len(
                        helper.args.defaults
                    )
                    for index, parameter in enumerate(positional_parameters):
                        if parameter.arg in bound:
                            continue
                        if index < defaults_start:
                            return None
                        bound[parameter.arg] = factory_value(
                            helper.args.defaults[index - defaults_start],
                            bindings,
                        )

                    if helper.args.vararg is not None:
                        bound[helper.args.vararg.arg] = tuple(
                            positional_values[len(positional_parameters) :]
                        )

                    for parameter, default in zip(
                        helper.args.kwonlyargs,
                        helper.args.kw_defaults,
                        strict=True,
                    ):
                        if parameter.arg in bound:
                            continue
                        if default is None:
                            return None
                        bound[parameter.arg] = factory_value(
                            default,
                            bindings,
                        )

                    if helper.args.kwarg is not None:
                        bound[helper.args.kwarg.arg] = extra_keywords
                    return bound

                def factory_helper_outcomes(
                    call: ast.Call,
                    bindings: dict[str, Any],
                    resolved_helper: ast.FunctionDef | None = None,
                ) -> list[tuple[str, dict[str, Any], Any]] | None:
                    resolved_bindings = dict(bindings)
                    helper = (
                        resolved_helper
                        if resolved_helper is not None
                        else factory_value(call.func, resolved_bindings)
                    )
                    if not isinstance(helper, ast.FunctionDef):
                        return None
                    globals_, nonlocals = function_scope_declarations(helper)
                    local_names = function_local_bindings(helper)
                    outcomes: list[tuple[str, dict[str, Any], Any]] = []
                    for (
                        argument_control,
                        evaluated_bindings,
                        argument_value,
                        argument_values,
                        evaluated_keywords,
                    ) in factory_call_argument_outcomes(
                        call,
                        resolved_bindings,
                    ):
                        if argument_control != "normal":
                            outcomes.append(
                                (
                                    argument_control,
                                    evaluated_bindings,
                                    argument_value,
                                )
                            )
                            continue
                        effect_names = (
                            (set(evaluated_bindings) - local_names)
                            | globals_
                            | nonlocals
                        )
                        if id(helper) in factory_call_stack:
                            nested = dict(evaluated_bindings)
                            for name in effect_names:
                                nested[name] = factory_unknown
                            outcomes.append(("normal", nested, factory_unknown))
                            continue

                        bound = bind_factory_helper_arguments(
                            helper,
                            call,
                            argument_values,
                            evaluated_keywords,
                            evaluated_bindings,
                        )
                        if bound is None:
                            nested = dict(evaluated_bindings)
                            invalidate_factory_call_values(
                                call,
                                argument_values,
                                evaluated_keywords,
                                nested,
                            )
                            outcomes.append(("normal", nested, factory_unknown))
                            continue

                        helper_bindings = dict(evaluated_bindings)
                        for name in local_names:
                            helper_bindings[name] = factory_unknown
                        helper_bindings.update(bound)

                        mutable_arguments: dict[int, Any] = {}
                        for value in (
                            *argument_values,
                            *(value for _, value in evaluated_keywords),
                        ):
                            collect_factory_mutable_values(
                                value,
                                evaluated_bindings,
                                mutable_arguments,
                            )
                        argument_aliases: list[tuple[str, Any]] = []
                        for index, original in enumerate(mutable_arguments.values()):
                            marker = f"\0factory-argument-{index}"
                            helper_bindings[marker] = original
                            argument_aliases.append((marker, original))

                        factory_call_stack.add(id(helper))
                        try:
                            helper_outcomes = factory_outcomes(
                                helper.body,
                                helper_bindings,
                            )
                        finally:
                            factory_call_stack.remove(id(helper))

                        for control, helper_result, value in helper_outcomes:
                            caller_result = dict(evaluated_bindings)
                            for name in effect_names:
                                if name in helper_result:
                                    caller_result[name] = helper_result[name]
                            for marker, original in argument_aliases:
                                updated = helper_result.get(marker, original)
                                if updated is original:
                                    continue
                                if updated is factory_unknown:
                                    invalidate_factory_aliases(
                                        original,
                                        caller_result,
                                    )
                                else:
                                    rebind_factory_aliases(
                                        original,
                                        updated,
                                        caller_result,
                                    )
                            outcomes.append((control, caller_result, value))
                    return outcomes

                def factory_expression_sequence(
                    expressions: list[ast.expr],
                    bindings: dict[str, Any],
                ) -> list[tuple[str, dict[str, Any], Any]]:
                    active: list[tuple[dict[str, Any], list[Any]]] = [
                        (dict(bindings), [])
                    ]
                    outcomes: list[tuple[str, dict[str, Any], Any]] = []
                    for expression in expressions:
                        following: list[tuple[dict[str, Any], list[Any]]] = []
                        for current, values in active:
                            for (
                                control,
                                evaluated,
                                value,
                            ) in factory_expression_outcomes(
                                expression,
                                current,
                            ):
                                if control != "normal":
                                    outcomes.append((control, evaluated, value))
                                    continue
                                following.append((evaluated, [*values, value]))
                        active = following
                    outcomes.extend(
                        ("normal", current, values) for current, values in active
                    )
                    return outcomes

                def factory_outcome_truth(value: Any) -> bool | None:
                    if value is factory_unknown or isinstance(value, ast.AST):
                        return None
                    try:
                        return bool(value)
                    except (TypeError, ValueError):
                        return None

                def factory_exception_status(
                    value: Any,
                    bindings: dict[str, Any],
                    *,
                    allow_none: bool,
                ) -> tuple[bool | None, str | FactoryClassValue | None]:
                    if value is factory_unknown:
                        return None, None
                    if value is None:
                        return allow_none, None
                    if isinstance(value, BaseException):
                        return True, type(value).__name__
                    resolved = resolve_factory_class(value, bindings)
                    if resolved is not factory_unknown:
                        valid = factory_class_is_subclass(
                            resolved,
                            BaseException,
                            bindings,
                        )
                        if isinstance(resolved, FactoryClassValue):
                            return (
                                valid,
                                resolved if valid is not False else None,
                            )
                        if isinstance(resolved, type):
                            return (
                                valid,
                                resolved.__name__ if valid else None,
                            )
                    if not isinstance(value, ast.expr):
                        return False, None
                    name = exception_expression_name(value)
                    if name is None:
                        return None, None
                    short_name = name.rsplit(".", 1)[-1]
                    target_expression = (
                        value.func if isinstance(value, ast.Call) else value
                    )
                    if (
                        "." not in name
                        and short_name in BUILTIN_EXCEPTION_NAMES
                        and factory_unshadowed_builtin(
                            target_expression,
                            short_name,
                            bindings,
                        )
                    ):
                        return True, short_name
                    if (
                        "." not in name
                        and short_name in BUILTIN_NAMES
                        and factory_unshadowed_builtin(
                            target_expression,
                            short_name,
                            bindings,
                        )
                    ):
                        return False, None
                    return None, name

                def resolve_factory_class(
                    value: Any,
                    bindings: dict[str, Any],
                    resolving: set[str] | None = None,
                ) -> Any:
                    if isinstance(value, FactoryInstanceValue):
                        return value.class_value
                    if isinstance(value, FactoryClassValue) or isinstance(
                        value,
                        type,
                    ):
                        return value
                    if isinstance(value, ast.Call):
                        return resolve_factory_class(
                            value.func,
                            bindings,
                            resolving,
                        )
                    if isinstance(value, ast.Name):
                        resolving = set() if resolving is None else resolving
                        if value.id in resolving:
                            return factory_unknown
                        if value.id in bindings:
                            return resolve_factory_class(
                                bindings[value.id],
                                bindings,
                                resolving | {value.id},
                            )
                        if factory_unshadowed_builtin(
                            value,
                            value.id,
                            bindings,
                        ):
                            builtin_value = vars(builtins).get(value.id)
                            if isinstance(builtin_value, type):
                                return builtin_value
                    if isinstance(value, ast.Attribute):
                        owner = factory_value(
                            value.value,
                            bindings,
                            resolving,
                        )
                        resolved = factory_attribute_value(
                            owner,
                            value.attr,
                            bindings,
                        )
                        if resolved is not factory_unknown:
                            return resolve_factory_class(
                                resolved,
                                bindings,
                                resolving,
                            )
                    return factory_unknown

                def factory_class_is_subclass(
                    candidate: Any,
                    expected: Any,
                    bindings: dict[str, Any],
                    resolving: set[int] | None = None,
                ) -> bool | None:
                    candidate = resolve_factory_class(candidate, bindings)
                    expected = resolve_factory_class(expected, bindings)
                    if (
                        candidate is factory_unknown
                        or expected is factory_unknown
                    ):
                        return None
                    if isinstance(candidate, type):
                        if not isinstance(expected, type):
                            return False
                        try:
                            return issubclass(candidate, expected)
                        except TypeError:
                            return False
                    if not isinstance(candidate, FactoryClassValue):
                        return False
                    if candidate is expected:
                        return True
                    resolving = set() if resolving is None else resolving
                    if id(candidate) in resolving:
                        return None
                    matches = [
                        factory_class_is_subclass(
                            base,
                            expected,
                            bindings,
                            resolving | {id(candidate)},
                        )
                        for base in candidate.bases
                    ]
                    if any(match is True for match in matches):
                        return True
                    if any(match is None for match in matches):
                        return None
                    return False

                def factory_class_value(
                    node: ast.ClassDef,
                    bindings: dict[str, Any],
                ) -> FactoryClassValue:
                    namespace = dict(bindings)
                    attrs: dict[str, Any] = {}
                    bases = tuple(
                        factory_value(base, namespace) for base in node.bases
                    )

                    def bind_attribute(target_node: ast.expr, value: Any) -> None:
                        if isinstance(target_node, ast.Name):
                            namespace[target_node.id] = value
                            attrs[target_node.id] = value
                        elif isinstance(target_node, (ast.Tuple, ast.List)):
                            values = value if isinstance(value, (tuple, list)) else ()
                            for index, item in enumerate(target_node.elts):
                                bind_attribute(
                                    item,
                                    (
                                        values[index]
                                        if index < len(values)
                                        else factory_unknown
                                    ),
                                )

                    for statement in node.body:
                        if isinstance(statement, ast.ClassDef):
                            value = factory_class_value(statement, namespace)
                            namespace[statement.name] = value
                            attrs[statement.name] = value
                        elif isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            namespace[statement.name] = statement
                            attrs[statement.name] = statement
                        elif isinstance(statement, ast.Assign):
                            value = factory_value(statement.value, namespace)
                            for assigned in statement.targets:
                                bind_attribute(assigned, value)
                        elif (
                            isinstance(statement, ast.AnnAssign)
                            and statement.value is not None
                        ):
                            bind_attribute(
                                statement.target,
                                factory_value(statement.value, namespace),
                            )
                    return FactoryClassValue(
                        node=node,
                        bases=bases,
                        attrs=attrs,
                    )

                def factory_handler_matches_exception(
                    handler: ast.ExceptHandler,
                    exception: Any,
                    bindings: dict[str, Any],
                ) -> bool | None:
                    if not isinstance(exception, FactoryClassValue):
                        if isinstance(exception, str) and "." in exception:
                            if handler.type is None:
                                return True
                            handled = (
                                handler.type.elts
                                if isinstance(handler.type, ast.Tuple)
                                else [handler.type]
                            )
                            names = {
                                name
                                for candidate in handled
                                if (name := dotted(candidate)) is not None
                            }
                            if exception in names:
                                return True
                            if names & {"BaseException", "Exception"}:
                                return None
                            return False
                        return handler_matches_exception(
                            handler,
                            exception if isinstance(exception, str) else None,
                        )
                    if handler.type is None:
                        return True
                    handled = (
                        handler.type.elts
                        if isinstance(handler.type, ast.Tuple)
                        else [handler.type]
                    )
                    matches = [
                        factory_class_is_subclass(
                            exception,
                            candidate,
                            bindings,
                        )
                        for candidate in handled
                    ]
                    if any(match is True for match in matches):
                        return True
                    if any(match is None for match in matches):
                        return None
                    return False

                def factory_comprehension_expression_outcomes(
                    expression: (
                        ast.ListComp | ast.SetComp | ast.DictComp | ast.GeneratorExp
                    ),
                    bindings: dict[str, Any],
                ) -> list[tuple[str, dict[str, Any], Any]]:
                    missing = object()

                    def target_names(target: ast.expr) -> set[str]:
                        if isinstance(target, ast.Name):
                            return {target.id}
                        if isinstance(target, (ast.Tuple, ast.List)):
                            return set().union(
                                *(target_names(item) for item in target.elts)
                            )
                        if isinstance(target, ast.Starred):
                            return target_names(target.value)
                        return set()

                    local_names = set().union(
                        *(
                            target_names(generator.target)
                            for generator in expression.generators
                        )
                    )
                    original_locals = {
                        name: bindings.get(name, missing) for name in local_names
                    }

                    def evaluate_filters(
                        filters: list[ast.expr],
                        state: dict[str, Any],
                    ) -> list[tuple[str, dict[str, Any], Any]]:
                        active = [dict(state)]
                        outcomes: list[tuple[str, dict[str, Any], Any]] = []
                        for condition in filters:
                            following: list[dict[str, Any]] = []
                            for current in active:
                                for (
                                    control,
                                    evaluated,
                                    value,
                                ) in factory_expression_outcomes(
                                    condition,
                                    current,
                                ):
                                    if control != "normal":
                                        outcomes.append((control, evaluated, value))
                                        continue
                                    truth = factory_outcome_truth(value)
                                    if truth is not True:
                                        outcomes.append(
                                            ("normal", dict(evaluated), False)
                                        )
                                    if truth is not False:
                                        following.append(evaluated)
                            active = following
                        outcomes.extend(("normal", current, True) for current in active)
                        return outcomes

                    def evaluate_result(
                        state: dict[str, Any],
                        result: Any,
                    ) -> list[tuple[str, dict[str, Any], Any]]:
                        expressions = (
                            [expression.key, expression.value]
                            if isinstance(expression, ast.DictComp)
                            else [expression.elt]
                        )
                        outcomes: list[tuple[str, dict[str, Any], Any]] = []
                        for control, evaluated, values in factory_expression_sequence(
                            expressions,
                            state,
                        ):
                            if control != "normal":
                                outcomes.append((control, evaluated, values))
                                continue
                            if result is factory_unknown:
                                updated = factory_unknown
                            elif isinstance(expression, ast.DictComp):
                                key, item = values
                                if (
                                    key is factory_unknown
                                    or isinstance(key, ast.AST)
                                ):
                                    updated = factory_unknown
                                else:
                                    updated = dict(result)
                                    try:
                                        updated[key] = item
                                    except TypeError:
                                        outcomes.append(
                                            ("raise", evaluated, "TypeError")
                                        )
                                        continue
                            elif isinstance(expression, ast.SetComp):
                                item = values[0]
                                if item is factory_unknown or isinstance(item, ast.AST):
                                    updated = factory_unknown
                                else:
                                    updated = set(result)
                                    try:
                                        updated.add(item)
                                    except TypeError:
                                        outcomes.append(
                                            ("raise", evaluated, "TypeError")
                                        )
                                        continue
                            else:
                                updated = [*result, values[0]]
                            outcomes.append(("normal", evaluated, updated))
                        return outcomes

                    def run_iteration(
                        index: int,
                        item: Any,
                        state: dict[str, Any],
                        result: Any,
                    ) -> list[tuple[str, dict[str, Any], Any]]:
                        generator = expression.generators[index]
                        nested = dict(state)
                        bind_factory_target(generator.target, item, nested)
                        outcomes: list[tuple[str, dict[str, Any], Any]] = []
                        for control, filtered, passed in evaluate_filters(
                            generator.ifs,
                            nested,
                        ):
                            if control != "normal":
                                outcomes.append((control, filtered, passed))
                            elif not passed:
                                outcomes.append(("normal", filtered, result))
                            elif index + 1 < len(expression.generators):
                                outcomes.extend(
                                    run_generator(index + 1, filtered, result)
                                )
                            else:
                                outcomes.extend(evaluate_result(filtered, result))
                        return outcomes

                    def run_items(
                        index: int,
                        items: list[Any],
                        state: dict[str, Any],
                        result: Any,
                    ) -> list[tuple[str, dict[str, Any], Any]]:
                        active = [(dict(state), result)]
                        outcomes: list[tuple[str, dict[str, Any], Any]] = []
                        for item in items:
                            following: list[tuple[dict[str, Any], Any]] = []
                            for current, current_result in active:
                                for (
                                    control,
                                    evaluated,
                                    value,
                                ) in run_iteration(
                                    index,
                                    item,
                                    current,
                                    current_result,
                                ):
                                    if control == "normal":
                                        following.append((evaluated, value))
                                    else:
                                        outcomes.append((control, evaluated, value))
                            active = following[:64]
                        outcomes.extend(
                            ("normal", current, current_result)
                            for current, current_result in active
                        )
                        return outcomes

                    def run_generator(
                        index: int,
                        state: dict[str, Any],
                        result: Any,
                    ) -> list[tuple[str, dict[str, Any], Any]]:
                        generator = expression.generators[index]
                        outcomes: list[tuple[str, dict[str, Any], Any]] = []
                        for (
                            control,
                            evaluated,
                            iterable,
                        ) in factory_expression_outcomes(
                            generator.iter,
                            state,
                        ):
                            if control != "normal":
                                outcomes.append((control, evaluated, iterable))
                                continue
                            items = static_factory_iterable_items(iterable)
                            uncertain = items is None or len(items) > 16
                            if uncertain:
                                outcomes.append(
                                    ("normal", dict(evaluated), result)
                                )
                                items = [factory_unknown]
                            outcomes.extend(
                                run_items(index, items, evaluated, result)
                            )
                        return outcomes

                    initial_result: Any
                    if isinstance(expression, ast.DictComp):
                        initial_result = {}
                    elif isinstance(expression, ast.SetComp):
                        initial_result = set()
                    else:
                        initial_result = []
                    if not expression.generators:
                        outcomes = [("normal", dict(bindings), initial_result)]
                    else:
                        outcomes = run_generator(
                            0,
                            dict(bindings),
                            initial_result,
                        )
                    restored: list[tuple[str, dict[str, Any], Any]] = []
                    for control, current, value in outcomes:
                        for name, original in original_locals.items():
                            if original is missing:
                                current.pop(name, None)
                            else:
                                current[name] = original
                        restored.append((control, current, value))
                    return restored

                def factory_expression_outcomes(
                    expression: ast.expr | None,
                    bindings: dict[str, Any],
                ) -> list[tuple[str, dict[str, Any], Any]]:
                    if expression is None:
                        return [("normal", dict(bindings), None)]
                    if isinstance(expression, ast.Call):
                        mutation_outcomes = path_sensitive_mutate_factory_call(
                            expression,
                            dict(bindings),
                        )
                        if mutation_outcomes is not None:
                            return mutation_outcomes
                        outcomes: list[tuple[str, dict[str, Any], Any]] = []
                        for (
                            function_control,
                            function_bindings,
                            function_value,
                        ) in factory_expression_outcomes(
                            expression.func,
                            dict(bindings),
                        ):
                            if function_control != "normal":
                                outcomes.append(
                                    (
                                        function_control,
                                        function_bindings,
                                        function_value,
                                    )
                                )
                                continue
                            if isinstance(function_value, ast.FunctionDef):
                                helper_outcomes = factory_helper_outcomes(
                                    expression,
                                    function_bindings,
                                    function_value,
                                )
                                if helper_outcomes is not None:
                                    outcomes.extend(
                                        (
                                            "normal",
                                            outcome_bindings,
                                            value if control == "return" else None,
                                        )
                                        if control in {"normal", "return"}
                                        else (
                                            control,
                                            outcome_bindings,
                                            value,
                                        )
                                        for (
                                            control,
                                            outcome_bindings,
                                            value,
                                        ) in helper_outcomes
                                    )
                                    continue
                            builtin_slice = factory_unshadowed_builtin(
                                expression.func,
                                "slice",
                                function_bindings,
                            )
                            for (
                                argument_control,
                                argument_bindings,
                                argument_value,
                                argument_values,
                                keyword_values,
                            ) in factory_call_argument_outcomes(
                                expression,
                                function_bindings,
                            ):
                                if argument_control != "normal":
                                    outcomes.append(
                                        (
                                            argument_control,
                                            argument_bindings,
                                            argument_value,
                                        )
                                    )
                                    continue
                                if builtin_slice:
                                    slice_control, slice_value = (
                                        factory_slice_call_result(
                                            expression,
                                            argument_values,
                                            keyword_values,
                                        )
                                    )
                                    outcomes.append(
                                        (
                                            slice_control,
                                            argument_bindings,
                                            slice_value,
                                        )
                                    )
                                    continue
                                invalidate_factory_call_values(
                                    expression,
                                    argument_values,
                                    keyword_values,
                                    argument_bindings,
                                )
                                outcomes.append(
                                    (
                                        "normal",
                                        argument_bindings,
                                        (
                                            FactoryInstanceValue(function_value)
                                            if isinstance(
                                                function_value,
                                                FactoryClassValue,
                                            )
                                            else expression
                                        ),
                                    )
                                )
                        return outcomes
                    if isinstance(expression, (ast.Name, ast.Constant)):
                        nested = dict(bindings)
                        return [
                            (
                                "normal",
                                nested,
                                factory_value(expression, nested),
                            )
                        ]
                    if isinstance(expression, ast.Lambda):
                        defaults = [
                            *expression.args.defaults,
                            *(
                                default
                                for default in expression.args.kw_defaults
                                if default is not None
                            ),
                        ]
                        return [
                            (
                                control,
                                evaluated,
                                expression if control == "normal" else value,
                            )
                            for control, evaluated, value in factory_expression_sequence(
                                defaults,
                                bindings,
                            )
                        ]
                    if isinstance(expression, ast.Attribute):
                        outcomes = []
                        for control, evaluated, owner in factory_expression_outcomes(
                            expression.value,
                            bindings,
                        ):
                            if control != "normal":
                                outcomes.append((control, evaluated, owner))
                                continue
                            value = factory_attribute_value(
                                owner,
                                expression.attr,
                                evaluated,
                            )
                            outcomes.append(
                                (
                                    "normal",
                                    evaluated,
                                    expression
                                    if value is factory_unknown
                                    else value,
                                )
                            )
                        return outcomes
                    if isinstance(expression, ast.Starred):
                        return factory_expression_outcomes(
                            expression.value,
                            bindings,
                        )
                    if isinstance(expression, (ast.List, ast.Tuple, ast.Set)):
                        outcomes: list[tuple[str, dict[str, Any], Any]] = []
                        for control, evaluated, values in factory_expression_sequence(
                            list(expression.elts),
                            bindings,
                        ):
                            if control != "normal":
                                outcomes.append((control, evaluated, values))
                                continue
                            expanded: list[Any] = []
                            valid = True
                            for item, value in zip(
                                expression.elts,
                                values,
                                strict=True,
                            ):
                                if not isinstance(item, ast.Starred):
                                    expanded.append(value)
                                    continue
                                items = static_factory_iterable_items(value)
                                if items is None:
                                    valid = False
                                else:
                                    expanded.extend(items)
                            if not valid:
                                result: Any = factory_unknown
                            elif isinstance(expression, ast.List):
                                result = expanded
                            elif isinstance(expression, ast.Tuple):
                                result = tuple(expanded)
                            elif any(item is factory_unknown for item in expanded):
                                result = factory_unknown
                            else:
                                try:
                                    result = set(expanded)
                                except TypeError:
                                    result = factory_unknown
                            outcomes.append(("normal", evaluated, result))
                        return outcomes
                    if isinstance(expression, ast.Dict):
                        active: list[tuple[dict[str, Any], dict[Any, Any], bool]] = [
                            (dict(bindings), {}, True)
                        ]
                        outcomes: list[tuple[str, dict[str, Any], Any]] = []
                        for key_node, value_node in zip(
                            expression.keys,
                            expression.values,
                            strict=True,
                        ):
                            following: list[
                                tuple[dict[str, Any], dict[Any, Any], bool]
                            ] = []
                            pair_expressions = (
                                [value_node]
                                if key_node is None
                                else [key_node, value_node]
                            )
                            for current, result, valid in active:
                                for (
                                    control,
                                    evaluated,
                                    values,
                                ) in factory_expression_sequence(
                                    pair_expressions,
                                    current,
                                ):
                                    if control != "normal":
                                        outcomes.append((control, evaluated, values))
                                        continue
                                    updated = dict(result)
                                    next_valid = valid
                                    if key_node is None:
                                        value = values[0]
                                        if isinstance(value, dict):
                                            updated.update(value)
                                        else:
                                            next_valid = False
                                    else:
                                        key, value = values
                                        if (
                                            key is factory_unknown
                                            or value is factory_unknown
                                            or isinstance(key, ast.AST)
                                        ):
                                            next_valid = False
                                        else:
                                            try:
                                                updated[key] = value
                                            except TypeError:
                                                next_valid = False
                                    following.append((evaluated, updated, next_valid))
                            active = following
                        outcomes.extend(
                            (
                                "normal",
                                current,
                                result if valid else factory_unknown,
                            )
                            for current, result, valid in active
                        )
                        return outcomes
                    if isinstance(expression, ast.Subscript):
                        outcomes = []
                        for control, evaluated, values in factory_expression_sequence(
                            [expression.value, expression.slice],
                            bindings,
                        ):
                            if control != "normal":
                                outcomes.append((control, evaluated, values))
                                continue
                            container, index = values
                            result = factory_unknown
                            if (
                                container is not factory_unknown
                                and index is not factory_unknown
                                and not isinstance(container, ast.AST)
                                and not isinstance(index, ast.AST)
                            ):
                                try:
                                    if type(container) in {
                                        list,
                                        tuple,
                                        str,
                                        bytes,
                                        dict,
                                    }:
                                        result = container[index]
                                    else:
                                        raise TypeError
                                except IndexError:
                                    outcomes.append(
                                        ("raise", evaluated, "IndexError")
                                    )
                                    continue
                                except KeyError:
                                    outcomes.append(("raise", evaluated, "KeyError"))
                                    continue
                                except TypeError:
                                    outcomes.append(
                                        ("raise", evaluated, "TypeError")
                                    )
                                    continue
                                except ValueError:
                                    outcomes.append(
                                        ("raise", evaluated, "ValueError")
                                    )
                                    continue
                            outcomes.append(("normal", evaluated, result))
                        return outcomes
                    if isinstance(expression, ast.BinOp):
                        outcomes = []
                        for control, evaluated, values in factory_expression_sequence(
                            [expression.left, expression.right],
                            bindings,
                        ):
                            outcomes.append(
                                (
                                    control,
                                    evaluated,
                                    (
                                        safe_factory_binary(
                                            expression.op,
                                            values[0],
                                            values[1],
                                        )
                                        if control == "normal"
                                        else values
                                    ),
                                )
                            )
                        return outcomes
                    if isinstance(expression, ast.UnaryOp):
                        outcomes = []
                        for (
                            control,
                            evaluated,
                            value,
                        ) in factory_expression_outcomes(
                            expression.operand,
                            bindings,
                        ):
                            if control != "normal":
                                outcomes.append((control, evaluated, value))
                                continue
                            result: Any = factory_unknown
                            if value is not factory_unknown and not isinstance(
                                value,
                                ast.AST,
                            ):
                                try:
                                    if isinstance(expression.op, ast.Not):
                                        result = not value
                                    elif isinstance(expression.op, ast.UAdd):
                                        result = +value
                                    elif isinstance(expression.op, ast.USub):
                                        result = -value
                                    elif isinstance(expression.op, ast.Invert):
                                        result = ~value
                                except (ArithmeticError, TypeError, ValueError):
                                    pass
                            outcomes.append(("normal", evaluated, result))
                        return outcomes
                    if isinstance(expression, ast.BoolOp):
                        active = [dict(bindings)]
                        outcomes = []
                        for index, item in enumerate(expression.values):
                            following = []
                            last = index + 1 == len(expression.values)
                            for current in active:
                                for (
                                    control,
                                    evaluated,
                                    value,
                                ) in factory_expression_outcomes(
                                    item,
                                    current,
                                ):
                                    if control != "normal":
                                        outcomes.append((control, evaluated, value))
                                        continue
                                    if last:
                                        outcomes.append(("normal", evaluated, value))
                                        continue
                                    truth = factory_outcome_truth(value)
                                    short_circuits = (
                                        truth is False
                                        if isinstance(expression.op, ast.And)
                                        else truth is True
                                    )
                                    continues = (
                                        truth is not False
                                        if isinstance(expression.op, ast.And)
                                        else truth is not True
                                    )
                                    if short_circuits or truth is None:
                                        outcomes.append(
                                            (
                                                "normal",
                                                dict(evaluated),
                                                value,
                                            )
                                        )
                                    if continues:
                                        following.append(evaluated)
                            active = following
                        return outcomes
                    if isinstance(expression, ast.IfExp):
                        outcomes = []
                        for (
                            control,
                            evaluated,
                            value,
                        ) in factory_expression_outcomes(
                            expression.test,
                            bindings,
                        ):
                            if control != "normal":
                                outcomes.append((control, evaluated, value))
                                continue
                            truth = factory_outcome_truth(value)
                            branches = (
                                (expression.body,)
                                if truth is True
                                else (expression.orelse,)
                                if truth is False
                                else (expression.body, expression.orelse)
                            )
                            for branch in branches:
                                outcomes.extend(
                                    factory_expression_outcomes(
                                        branch,
                                        dict(evaluated),
                                    )
                                )
                        return outcomes
                    if isinstance(expression, ast.Compare):
                        active: list[tuple[dict[str, Any], Any]] = []
                        outcomes = []
                        for (
                            control,
                            evaluated,
                            value,
                        ) in factory_expression_outcomes(
                            expression.left,
                            bindings,
                        ):
                            if control == "normal":
                                active.append((evaluated, value))
                            else:
                                outcomes.append((control, evaluated, value))
                        for index, (operator, comparator) in enumerate(
                            zip(
                                expression.ops,
                                expression.comparators,
                                strict=True,
                            )
                        ):
                            following: list[tuple[dict[str, Any], Any]] = []
                            last = index + 1 == len(expression.comparators)
                            for current, left in active:
                                for (
                                    control,
                                    evaluated,
                                    right,
                                ) in factory_expression_outcomes(
                                    comparator,
                                    current,
                                ):
                                    if control != "normal":
                                        outcomes.append((control, evaluated, right))
                                        continue
                                    comparison = safe_factory_compare(
                                        operator,
                                        left,
                                        right,
                                    )
                                    if comparison is False:
                                        outcomes.append(("normal", evaluated, False))
                                    elif last:
                                        outcomes.append(
                                            (
                                                "normal",
                                                evaluated,
                                                (
                                                    True
                                                    if comparison is True
                                                    else factory_unknown
                                                ),
                                            )
                                        )
                                    else:
                                        if comparison is None:
                                            outcomes.append(
                                                (
                                                    "normal",
                                                    dict(evaluated),
                                                    factory_unknown,
                                                )
                                            )
                                        following.append((evaluated, right))
                            active = following
                        return outcomes
                    if isinstance(expression, ast.JoinedStr):
                        return [
                            (
                                control,
                                evaluated,
                                expression if control == "normal" else value,
                            )
                            for control, evaluated, value in factory_expression_sequence(
                                list(expression.values),
                                bindings,
                            )
                        ]
                    if isinstance(expression, ast.FormattedValue):
                        parts = [expression.value]
                        if expression.format_spec is not None:
                            parts.append(expression.format_spec)
                        return [
                            (
                                control,
                                evaluated,
                                expression if control == "normal" else value,
                            )
                            for control, evaluated, value in factory_expression_sequence(
                                parts,
                                bindings,
                            )
                        ]
                    if isinstance(expression, ast.Slice):
                        parts = [
                            part
                            for part in (
                                expression.lower,
                                expression.upper,
                                expression.step,
                            )
                            if part is not None
                        ]
                        outcomes = []
                        for control, evaluated, values in factory_expression_sequence(
                            parts,
                            bindings,
                        ):
                            if control != "normal":
                                outcomes.append((control, evaluated, values))
                                continue
                            value_index = 0
                            resolved: list[Any] = []
                            valid = True
                            for part in (
                                expression.lower,
                                expression.upper,
                                expression.step,
                            ):
                                if part is None:
                                    resolved.append(None)
                                    continue
                                value = values[value_index]
                                value_index += 1
                                resolved.append(value)
                                valid = valid and (
                                    value is not factory_unknown
                                    and not isinstance(value, ast.AST)
                                )
                            outcomes.append(
                                (
                                    "normal",
                                    evaluated,
                                    slice(*resolved) if valid else factory_unknown,
                                )
                            )
                        return outcomes
                    if isinstance(expression, ast.GeneratorExp):
                        if not expression.generators:
                            return [("normal", dict(bindings), expression)]
                        return [
                            (
                                control,
                                evaluated,
                                expression if control == "normal" else value,
                            )
                            for control, evaluated, value in factory_expression_outcomes(
                                expression.generators[0].iter,
                                bindings,
                            )
                        ]
                    if isinstance(
                        expression,
                        (ast.ListComp, ast.SetComp, ast.DictComp),
                    ):
                        return factory_comprehension_expression_outcomes(
                            expression,
                            bindings,
                        )
                    if isinstance(expression, ast.NamedExpr):
                        outcomes = []
                        for (
                            control,
                            evaluated,
                            value,
                        ) in factory_expression_outcomes(
                            expression.value,
                            bindings,
                        ):
                            if control == "normal":
                                bind_factory_target(
                                    expression.target,
                                    value,
                                    evaluated,
                                )
                            outcomes.append((control, evaluated, value))
                        return outcomes
                    if isinstance(
                        expression,
                        (ast.Await, ast.Yield, ast.YieldFrom),
                    ):
                        return [
                            (
                                control,
                                evaluated,
                                expression if control == "normal" else value,
                            )
                            for control, evaluated, value in factory_expression_outcomes(
                                expression.value,
                                bindings,
                            )
                        ]
                    children: list[ast.expr] = []
                    for _, child in ast.iter_fields(expression):
                        if isinstance(child, ast.expr):
                            children.append(child)
                        elif isinstance(child, (list, tuple)):
                            children.extend(
                                item for item in child if isinstance(item, ast.expr)
                            )
                    return [
                        (
                            control,
                            evaluated,
                            expression if control == "normal" else value,
                        )
                        for control, evaluated, value in factory_expression_sequence(
                            children,
                            bindings,
                        )
                    ]

                def factory_outcomes(
                    statements: list[ast.stmt],
                    bindings: dict[str, Any],
                ) -> list[tuple[str, dict[str, Any], Any]]:
                    outcomes: list[tuple[str, dict[str, Any], Any]] = [
                        ("normal", dict(bindings), None)
                    ]
                    for statement in statements:
                        expanded: list[tuple[str, dict[str, Any], Any]] = []
                        for control, current, returned in outcomes:
                            if control != "normal":
                                expanded.append((control, current, returned))
                                continue
                            if isinstance(
                                statement,
                                (ast.FunctionDef, ast.AsyncFunctionDef),
                            ):
                                nested = dict(current)
                                nested[statement.name] = statement
                                expanded.append(("normal", nested, None))
                            elif isinstance(statement, ast.ClassDef):
                                nested = dict(current)
                                nested[statement.name] = factory_class_value(
                                    statement,
                                    current,
                                )
                                expanded.append(("normal", nested, None))
                            elif isinstance(statement, ast.Assign):
                                for (
                                    expression_control,
                                    expression_bindings,
                                    expression_value,
                                ) in factory_expression_outcomes(
                                    statement.value,
                                    current,
                                ):
                                    if expression_control != "normal":
                                        expanded.append(
                                            (
                                                expression_control,
                                                expression_bindings,
                                                expression_value,
                                            )
                                        )
                                        continue
                                    for assigned in statement.targets:
                                        bind_factory_target(
                                            assigned,
                                            expression_value,
                                            expression_bindings,
                                        )
                                    expanded.append(
                                        (
                                            "normal",
                                            expression_bindings,
                                            None,
                                        )
                                    )
                            elif (
                                isinstance(statement, ast.AnnAssign)
                                and statement.value is not None
                            ):
                                for (
                                    expression_control,
                                    expression_bindings,
                                    expression_value,
                                ) in factory_expression_outcomes(
                                    statement.value,
                                    current,
                                ):
                                    if expression_control != "normal":
                                        expanded.append(
                                            (
                                                expression_control,
                                                expression_bindings,
                                                expression_value,
                                            )
                                        )
                                        continue
                                    bind_factory_target(
                                        statement.target,
                                        expression_value,
                                        expression_bindings,
                                    )
                                    expanded.append(
                                        (
                                            "normal",
                                            expression_bindings,
                                            None,
                                        )
                                    )
                            elif isinstance(statement, ast.AugAssign):
                                nested = dict(current)
                                value = safe_factory_binary(
                                    statement.op,
                                    factory_value(statement.target, nested),
                                    factory_value(statement.value, nested),
                                )
                                if value is factory_unknown or isinstance(
                                    value, (dict, list, set)
                                ):
                                    invalidate_factory_target(
                                        statement.target,
                                        nested,
                                    )
                                else:
                                    bind_factory_target(
                                        statement.target,
                                        value,
                                        nested,
                                    )
                                expanded.append(("normal", nested, None))
                            elif isinstance(statement, ast.Delete):
                                nested = dict(current)
                                for deleted in statement.targets:
                                    invalidate_factory_target(deleted, nested)
                                expanded.append(("normal", nested, None))
                            elif isinstance(statement, ast.Expr):
                                for (
                                    expression_control,
                                    expression_bindings,
                                    expression_value,
                                ) in factory_expression_outcomes(
                                    statement.value,
                                    current,
                                ):
                                    expanded.append(
                                        (
                                            "normal",
                                            expression_bindings,
                                            None,
                                        )
                                        if expression_control == "normal"
                                        else (
                                            expression_control,
                                            expression_bindings,
                                            expression_value,
                                        )
                                    )
                            elif (
                                isinstance(statement, ast.AnnAssign)
                                and statement.value is None
                            ):
                                nested = dict(current)
                                invalidate_factory_target(
                                    statement.target,
                                    nested,
                                )
                                expanded.append(("normal", nested, None))
                            elif isinstance(statement, ast.If):
                                condition = factory_truth(
                                    statement.test,
                                    current,
                                )
                                branches: list[list[ast.stmt]] = []
                                if condition is not False:
                                    branches.append(statement.body)
                                if condition is not True:
                                    branches.append(statement.orelse)
                                for branch in branches:
                                    expanded.extend(factory_outcomes(branch, current))
                            elif isinstance(
                                statement,
                                (ast.For, ast.AsyncFor),
                            ):
                                resolved_iterable = factory_value(
                                    statement.iter,
                                    current,
                                )
                                if isinstance(
                                    resolved_iterable,
                                    (list, tuple, set),
                                ):
                                    items = list(resolved_iterable)
                                    cardinality = len(items)
                                elif isinstance(resolved_iterable, dict):
                                    items = list(resolved_iterable)
                                    cardinality = len(items)
                                else:
                                    iterable = factory_literal(
                                        statement.iter,
                                        current,
                                    )
                                if (
                                    not isinstance(
                                        resolved_iterable,
                                        (
                                            list,
                                            tuple,
                                            set,
                                            dict,
                                        ),
                                    )
                                    and iterable is not _UNKNOWN_LITERAL
                                ):
                                    try:
                                        items = list(iterable)
                                    except TypeError:
                                        items = []
                                    cardinality: int | None = len(items)
                                elif not isinstance(
                                    resolved_iterable,
                                    (
                                        list,
                                        tuple,
                                        set,
                                        dict,
                                    ),
                                ):
                                    cardinality = static_iterable_cardinality(
                                        statement.iter,
                                        builtin_available=lambda _name: True,
                                    )
                                    items = (
                                        []
                                        if cardinality == 0
                                        else [
                                            ast.Name(
                                                id="__hyoka_unknown",
                                                ctx=ast.Load(),
                                            )
                                        ]
                                        * min(cardinality or 1, 16)
                                    )

                                def run_for_items(
                                    loop_items: list[Any],
                                ) -> list[tuple[str, dict[str, Any], Any]]:
                                    active = [("normal", dict(current), None)]
                                    completed: list[
                                        tuple[str, dict[str, Any], Any]
                                    ] = []
                                    for item in loop_items:
                                        following: list[
                                            tuple[str, dict[str, Any], Any]
                                        ] = []
                                        for (
                                            loop_control,
                                            loop_bindings,
                                            loop_value,
                                        ) in active:
                                            if loop_control != "normal":
                                                completed.append(
                                                    (
                                                        loop_control,
                                                        loop_bindings,
                                                        loop_value,
                                                    )
                                                )
                                                continue
                                            nested = dict(loop_bindings)
                                            bind_factory_target(
                                                statement.target,
                                                item,
                                                nested,
                                            )
                                            for (
                                                body_control,
                                                body_bindings,
                                                body_value,
                                            ) in factory_outcomes(
                                                statement.body,
                                                nested,
                                            ):
                                                if body_control == "break":
                                                    completed.append(
                                                        (
                                                            "loop-break",
                                                            body_bindings,
                                                            None,
                                                        )
                                                    )
                                                elif body_control in {
                                                    "normal",
                                                    "continue",
                                                }:
                                                    following.append(
                                                        (
                                                            "normal",
                                                            body_bindings,
                                                            None,
                                                        )
                                                    )
                                                else:
                                                    completed.append(
                                                        (
                                                            body_control,
                                                            body_bindings,
                                                            body_value,
                                                        )
                                                    )
                                        active = following
                                    for (
                                        loop_control,
                                        loop_bindings,
                                        loop_value,
                                    ) in (*completed, *active):
                                        if loop_control == "normal":
                                            expanded.extend(
                                                factory_outcomes(
                                                    statement.orelse,
                                                    loop_bindings,
                                                )
                                            )
                                        elif loop_control == "loop-break":
                                            expanded.append(
                                                (
                                                    "normal",
                                                    loop_bindings,
                                                    None,
                                                )
                                            )
                                        else:
                                            expanded.append(
                                                (
                                                    loop_control,
                                                    loop_bindings,
                                                    loop_value,
                                                )
                                            )
                                    return expanded

                                if cardinality == 0:
                                    expanded.extend(
                                        factory_outcomes(
                                            statement.orelse,
                                            current,
                                        )
                                    )
                                elif cardinality is not None:
                                    run_for_items(items)
                                else:
                                    expanded.extend(
                                        factory_outcomes(
                                            statement.orelse,
                                            current,
                                        )
                                    )
                                    before_nonempty = len(expanded)
                                    run_for_items(items)
                                    if any(
                                        control_name == "normal"
                                        for control_name, _, _ in expanded[
                                            before_nonempty:
                                        ]
                                    ):
                                        expanded.append(("halt", dict(current), None))
                            elif isinstance(statement, ast.While):
                                active = [dict(current)]
                                completed: list[tuple[str, dict[str, Any], Any]] = []
                                for _ in range(16):
                                    if not active:
                                        break
                                    following: list[dict[str, Any]] = []
                                    for loop_bindings in active:
                                        condition = factory_truth(
                                            statement.test,
                                            loop_bindings,
                                        )
                                        if condition is not True:
                                            completed.extend(
                                                factory_outcomes(
                                                    statement.orelse,
                                                    loop_bindings,
                                                )
                                            )
                                        if condition is False:
                                            continue
                                        for (
                                            body_control,
                                            body_bindings,
                                            body_value,
                                        ) in factory_outcomes(
                                            statement.body,
                                            loop_bindings,
                                        ):
                                            if body_control == "break":
                                                completed.append(
                                                    (
                                                        "normal",
                                                        body_bindings,
                                                        None,
                                                    )
                                                )
                                            elif body_control in {
                                                "normal",
                                                "continue",
                                            }:
                                                following.append(body_bindings)
                                            else:
                                                completed.append(
                                                    (
                                                        body_control,
                                                        body_bindings,
                                                        body_value,
                                                    )
                                                )
                                    active = following[:64]
                                expanded.extend(completed)
                                expanded.extend(
                                    ("halt", loop_bindings, None)
                                    for loop_bindings in active
                                )
                            elif isinstance(statement, (ast.With, ast.AsyncWith)):
                                expanded.extend(
                                    factory_outcomes(
                                        statement.body,
                                        current,
                                    )
                                )
                            elif isinstance(statement, (ast.Try, ast.TryStar)):
                                attempted = factory_outcomes(
                                    statement.body,
                                    current,
                                )
                                branches: list[tuple[str, dict[str, Any], Any]] = []
                                for (
                                    try_control,
                                    try_bindings,
                                    try_value,
                                ) in attempted:
                                    if try_control == "normal":
                                        branches.extend(
                                            factory_outcomes(
                                                statement.orelse,
                                                try_bindings,
                                            )
                                        )
                                        continue
                                    if try_control != "raise":
                                        branches.append(
                                            (
                                                try_control,
                                                try_bindings,
                                                try_value,
                                            )
                                        )
                                        continue
                                    matched = False
                                    uncertain = False
                                    for handler in statement.handlers:
                                        match = factory_handler_matches_exception(
                                            handler,
                                            try_value,
                                            try_bindings,
                                        )
                                        if match is False:
                                            continue
                                        handled = dict(try_bindings)
                                        if handler.name:
                                            handled[handler.name] = ast.Name(
                                                id="__hyoka_exception",
                                                ctx=ast.Load(),
                                            )
                                        branches.extend(
                                            factory_outcomes(
                                                handler.body,
                                                handled,
                                            )
                                        )
                                        matched = matched or match is True
                                        uncertain = uncertain or match is None
                                        if match is True:
                                            break
                                    if not matched or uncertain:
                                        branches.append(
                                            (
                                                try_control,
                                                try_bindings,
                                                try_value,
                                            )
                                        )
                                for (
                                    branch_control,
                                    branch_bindings,
                                    branch_value,
                                ) in branches:
                                    final_outcomes = factory_outcomes(
                                        statement.finalbody,
                                        branch_bindings,
                                    )
                                    for (
                                        final_control,
                                        final_bindings,
                                        final_value,
                                    ) in final_outcomes:
                                        expanded.append(
                                            (
                                                final_control,
                                                final_bindings,
                                                final_value,
                                            )
                                            if final_control != "normal"
                                            else (
                                                branch_control,
                                                final_bindings,
                                                branch_value,
                                            )
                                        )
                            elif isinstance(statement, ast.Match):
                                subject = factory_literal(
                                    statement.subject,
                                    current,
                                )
                                exhaustive = False
                                for case in statement.cases:
                                    matches = static_match_pattern(
                                        case.pattern,
                                        subject,
                                    )
                                    if matches is False:
                                        continue
                                    nested = dict(current)
                                    for name in match_bound_names(case.pattern):
                                        nested[name] = snapshot_binding(
                                            statement.subject,
                                            current,
                                        )
                                    guard = (
                                        factory_truth(case.guard, nested)
                                        if case.guard is not None
                                        else True
                                    )
                                    if guard is False:
                                        continue
                                    expanded.extend(
                                        factory_outcomes(
                                            case.body,
                                            nested,
                                        )
                                    )
                                    if matches is True and guard is True:
                                        exhaustive = True
                                        break
                                if not exhaustive:
                                    expanded.append(("normal", dict(current), None))
                            elif isinstance(statement, ast.Return):
                                for (
                                    expression_control,
                                    expression_bindings,
                                    expression_value,
                                ) in factory_expression_outcomes(
                                    statement.value,
                                    current,
                                ):
                                    expanded.append(
                                        (
                                            "return",
                                            expression_bindings,
                                            expression_value,
                                        )
                                        if expression_control == "normal"
                                        else (
                                            expression_control,
                                            expression_bindings,
                                            expression_value,
                                        )
                                    )
                            elif isinstance(statement, ast.Raise):
                                for (
                                    exception_control,
                                    exception_bindings,
                                    exception_value,
                                ) in factory_expression_outcomes(
                                    statement.exc,
                                    current,
                                ):
                                    if exception_control != "normal":
                                        expanded.append(
                                            (
                                                exception_control,
                                                exception_bindings,
                                                exception_value,
                                            )
                                        )
                                        continue
                                    if statement.exc is None:
                                        expanded.append(
                                            (
                                                "raise",
                                                exception_bindings,
                                                None,
                                            )
                                        )
                                        continue
                                    cause_outcomes = factory_expression_outcomes(
                                        statement.cause,
                                        exception_bindings,
                                    )
                                    for (
                                        cause_control,
                                        cause_bindings,
                                        cause_value,
                                    ) in cause_outcomes:
                                        if cause_control != "normal":
                                            expanded.append(
                                                (
                                                    cause_control,
                                                    cause_bindings,
                                                    cause_value,
                                                )
                                            )
                                            continue
                                        exception_valid, exception_name = (
                                            factory_exception_status(
                                                exception_value,
                                                cause_bindings,
                                                allow_none=False,
                                            )
                                        )
                                        cause_valid, _ = factory_exception_status(
                                            cause_value,
                                            cause_bindings,
                                            allow_none=True,
                                        )
                                        if (
                                            exception_valid is False
                                            or cause_valid is False
                                        ):
                                            exception_name = "TypeError"
                                        elif exception_name is None and (
                                            exception_value is not factory_unknown
                                        ):
                                            exception_name = (
                                                exception_expression_name(
                                                    statement.exc,
                                                )
                                            )
                                        expanded.append(
                                            (
                                                "raise",
                                                cause_bindings,
                                                exception_name,
                                            )
                                        )
                            elif isinstance(statement, ast.Break):
                                expanded.append(("break", current, None))
                            elif isinstance(statement, ast.Continue):
                                expanded.append(("continue", current, None))
                            else:
                                expanded.append(("normal", current, None))
                        outcomes = expanded
                    return outcomes

                def returned_callable_warns(
                    returned: Any,
                    resolving: set[str] | None = None,
                ) -> bool:
                    resolving = set() if resolving is None else resolving
                    if isinstance(returned, ast.IfExp):
                        condition = static_literal_truth(returned.test)
                        choices = []
                        if condition is not False:
                            choices.append(returned.body)
                        if condition is not True:
                            choices.append(returned.orelse)
                        return bool(choices) and all(
                            returned_callable_warns(choice, resolving)
                            for choice in choices
                        )
                    if isinstance(returned, ast.Lambda):
                        if any(
                            called_warning_helper(
                                call,
                                awaited,
                                local_helpers,
                                owner,
                                shadowed,
                            )
                            for call, awaited in direct_calls(returned.body)
                        ):
                            return True
                        return False
                    if isinstance(
                        returned,
                        (ast.FunctionDef, ast.AsyncFunctionDef),
                    ):
                        decorator = FunctionInfo(
                            key=(
                                f"{target.key}:<decorator>."
                                f"{returned.name}@{returned.lineno}"
                            ),
                            module=target.module,
                            node=returned,
                        )
                    elif isinstance(returned, ast.Name):
                        if returned.id in resolving:
                            return False
                        value = module.env.get(returned.id)
                        decorator = (
                            value.data if value and value.kind == "function" else None
                        )
                    else:
                        decorator = None
                    return bool(
                        decorator is not None
                        and decorator.key not in seen
                        and self.statements_warn(
                            decorator.node.body,
                            self.modules[decorator.module],
                            decorator,
                            seen | {target.key, decorator.key},
                        )
                    )

                outcomes = factory_outcomes(target.node.body, {})
                returned = [
                    value for control, _, value in outcomes if control == "return"
                ]
                falls_through = any(control == "normal" for control, _, _ in outcomes)
                return (
                    bool(returned)
                    and not falls_through
                    and all(returned_callable_warns(value) for value in returned)
                )

            def expressions_warn(
                expressions: list[ast.expr],
                *,
                decorators: bool = False,
            ) -> bool:
                if any(
                    called_warning_helper(
                        call,
                        awaited,
                        local_helpers,
                        owner,
                        shadowed,
                    )
                    for expression in expressions
                    for call, awaited in direct_calls(expression)
                ):
                    return True
                if not decorators:
                    return False
                return any(
                    called_warning_helper(
                        ast.Call(func=expression, args=[], keywords=[]),
                        False,
                        local_helpers,
                        owner,
                        shadowed,
                    )
                    for expression in expressions
                    if isinstance(expression, (ast.Name, ast.Attribute))
                ) or any(
                    decorator_factory_result_warn(expression)
                    for expression in expressions
                )

            local_helpers = dict(helpers)
            for statement in block:
                if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if expressions_warn(
                        list(statement.decorator_list),
                        decorators=True,
                    ):
                        return True
                    expressions = [
                        *statement.args.defaults,
                        *(
                            default
                            for default in statement.args.kw_defaults
                            if default is not None
                        ),
                        *(
                            ()
                            if module.postponed_annotations
                            else function_annotation_expressions(statement)
                        ),
                    ]
                    if expressions_warn(expressions):
                        return True
                    local_helpers[statement.name] = FunctionInfo(
                        key=(
                            f"{owner.key}:<warning-locals>."
                            f"{statement.name}@{statement.lineno}"
                        ),
                        module=owner.module,
                        node=statement,
                    )
                    continue
                if isinstance(statement, ast.ClassDef):
                    if expressions_warn(
                        list(statement.decorator_list),
                        decorators=True,
                    ):
                        return True
                    if expressions_warn(
                        [
                            *statement.bases,
                            *(keyword.value for keyword in statement.keywords),
                        ]
                    ):
                        return True
                    if scan_block(
                        statement.body,
                        owner,
                        {},
                        shadowed,
                    ):
                        return True
                    local_helpers[statement.name] = statement
                    continue
                if isinstance(statement, (ast.Assign, ast.AnnAssign)):
                    value = statement.value
                    if value is not None:
                        for call, awaited in direct_calls(value):
                            if called_warning_helper(
                                call,
                                awaited,
                                local_helpers,
                                owner,
                                shadowed,
                            ):
                                return True
                    targets = (
                        statement.targets
                        if isinstance(statement, ast.Assign)
                        else [statement.target]
                    )
                    for target_node in targets:
                        if isinstance(target_node, ast.Name):
                            if isinstance(value, ast.Lambda):
                                local_helpers[target_node.id] = value
                            elif (
                                isinstance(value, ast.Call)
                                and isinstance(value.func, ast.Name)
                                and isinstance(
                                    local_helpers.get(value.func.id),
                                    ast.ClassDef,
                                )
                            ):
                                local_helpers[target_node.id] = (
                                    "class-instance",
                                    local_helpers[value.func.id],
                                )
                            else:
                                local_helpers[target_node.id] = None
                    continue
                if isinstance(statement, ast.If):
                    for call, awaited in direct_calls(statement.test):
                        if called_warning_helper(
                            call,
                            awaited,
                            local_helpers,
                            owner,
                            shadowed,
                        ):
                            return True
                    if scan_block(
                        statement.body,
                        owner,
                        local_helpers,
                        shadowed,
                    ) or scan_block(
                        statement.orelse,
                        owner,
                        local_helpers,
                        shadowed,
                    ):
                        return True
                    continue
                nested_blocks: list[list[ast.stmt]] = []
                if isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
                    nested_blocks = [statement.body, statement.orelse]
                elif isinstance(statement, (ast.With, ast.AsyncWith)):
                    nested_blocks = [statement.body]
                elif isinstance(statement, (ast.Try, ast.TryStar)):
                    nested_blocks = [
                        statement.body,
                        statement.orelse,
                        statement.finalbody,
                        *(handler.body for handler in statement.handlers),
                    ]
                for call, awaited in direct_calls(statement):
                    if called_warning_helper(
                        call,
                        awaited,
                        local_helpers,
                        owner,
                        shadowed,
                    ):
                        return True
                if any(
                    scan_block(
                        nested,
                        owner,
                        local_helpers,
                        shadowed,
                    )
                    for nested in nested_blocks
                ):
                    return True
            return False

        return scan_block(statements, function, {}, set())

    @staticmethod
    def parameter_nodes(function: FunctionInfo) -> list[ast.arg]:
        parameters = (
            list(function.node.args.posonlyargs)
            + list(function.node.args.args)
            + list(function.node.args.kwonlyargs)
        )
        if function.class_key and parameters:
            parameters = parameters[1:]
        return parameters

    def parameter_roles(
        self,
        function: FunctionInfo,
    ) -> tuple[set[str], set[str]]:
        parameters = self.parameter_nodes(function)
        details = []
        for parameter in parameters:
            annotation = (
                ast.unparse(parameter.annotation).replace(" ", "").lower()
                if parameter.annotation is not None
                else ""
            )
            details.append((parameter.arg, annotation))
        subject = {
            name
            for name, _ in details
            if "subject" in name.lower()
            or name.lower()
            in {
                "filter_path",
                "filterpath",
                "event_path",
                "eventpath",
            }
        }
        if not subject:
            string_parameters = [
                name
                for name, annotation in details
                if annotation in {"str", "builtins.str"}
                and not re.search(
                    r"endpoint|topic|url|credential|setting|client",
                    name,
                    re.IGNORECASE,
                )
            ]
            if len(string_parameters) == 1:
                subject.add(string_parameters[0])
        data = {
            name
            for name, annotation in details
            if (
                re.search(
                    r"data|payload|notification|event|item|message|content|detail|body|batch",
                    name,
                    re.IGNORECASE,
                )
                and name not in subject
            )
            or (
                bool(
                    set(re.findall(r"[a-z_][a-z0-9_]*", annotation))
                    & {
                        "dict",
                        "mapping",
                        "list",
                        "tuple",
                        "set",
                        "iterable",
                        "sequence",
                        "collection",
                    }
                )
                and name not in subject
            )
        }
        return subject, data

    def public_function(self, function: FunctionInfo) -> bool:
        return not function.node.name.startswith("_")

    def operation_has_provenance(
        self,
        operation: dict[str, Any],
        *,
        require_subject: bool,
        tag_field: str,
    ) -> bool:
        tags = set(operation.get(tag_field, ()))
        for key in operation.get("stack", ()):
            function = self.function(key)
            if not function or not self.public_function(function):
                continue
            subject, data = self.parameter_roles(function)
            if not data:
                continue
            data_connected = any(
                f"input:{function.key}:{name}" in tags for name in data
            )
            if not data_connected:
                return False
            if not require_subject:
                return True
            subject_tags = set(operation.get("subject_tags", ()))
            if not subject:
                return any(
                    f"input:{function.key}:{name}" in subject_tags
                    for name in data
                )
            return any(
                f"input:{function.key}:{name}" in subject_tags for name in subject
            )
        return False

    def receiver_function(self, function: FunctionInfo, async_mode: bool) -> bool:
        if function.node.name == "main" or function.is_async != async_mode:
            return False
        for parameter in self.parameter_nodes(function):
            name = parameter.arg.lower()
            annotation = (
                ast.unparse(parameter.annotation).replace(" ", "").lower()
                if parameter.annotation is not None
                else ""
            )
            if re.search(r"payload|body|json|raw", name) or any(
                marker in annotation
                for marker in ("str", "bytes", "iterable", "sequence", "collection")
            ):
                return True
        return False

    def connected_demo_sample(self, operation: dict[str, Any]) -> bool:
        if not operation.get("sample_valid"):
            return False
        async_mode = bool(operation.get("async"))
        return any(
            (function := self.function(key)) is not None
            and self.receiver_function(function, async_mode)
            for key in operation.get("receiver_stack", ())
        )

    def local_calls(self, statements: list[ast.stmt], module: ModuleInfo) -> set[str]:
        calls: set[str] = set()
        for statement in statements:
            for node in ast.walk(statement):
                if not isinstance(node, ast.Call):
                    continue
                if isinstance(node.func, ast.Name):
                    value = module.env.get(node.func.id)
                    if value and value.kind == "function":
                        calls.add(value.data.key)
        return calls

    def reachable_uses_origin(self, origins: set[str]) -> bool:
        return any(
            operation["kind"] == "origin-call" and operation["origin"] in origins
            for operation in self.operations
        )

    def insecure_auth_present(self) -> bool:
        forbidden = {
            "azure.core.credentials.AzureKeyCredential",
            "azure.core.credentials.AzureSasCredential",
            "azure.storage.blob.BlobServiceClient.from_connection_string",
            "azure.storage.blob.aio.BlobServiceClient.from_connection_string",
        }
        return self.reachable_uses_origin(forbidden)

    def evaluate(self, manifests: list[dict[str, str]]) -> dict[str, bool]:
        packages = packages_from_manifests(manifests)
        results = {rule: False for rule in RULES}
        results["prompt/sdk-packages"] = {
            "azure-eventgrid",
            "azure-identity",
            "azure-storage-blob",
        } <= packages
        if not self.valid:
            return results

        self.execute()
        self.tainted_warning_roots = self.warning_api_mutations()
        routes = self.route_functions()
        route_calls = [
            operation
            for operation in self.operations
            if operation["kind"] == "event-call" and operation["target"] in routes
        ]
        sync_route_calls = [
            operation for operation in route_calls if not operation["async"]
        ]
        async_route_calls = [
            operation for operation in route_calls if operation["async"]
        ]
        reachable_manual_json = self.reachable_uses_origin({"json.loads"})
        sync_schemas = {operation["schema"] for operation in sync_route_calls}
        async_schemas = {operation["schema"] for operation in async_route_calls}

        results["prompt/sdk-event-deserialization"] = (
            sync_schemas == {"eventgrid", "cloud"} and not reachable_manual_json
        )

        sync_routes = {
            key: route for key, route in routes.items() if not route["async"]
        }
        async_routes = {key: route for key, route in routes.items() if route["async"]}
        all_blob_clients = {
            operation["blob_id"]: operation
            for operation in self.operations
            if operation["kind"] == "blob-client"
        }
        blob_clients = {
            blob_id: operation
            for blob_id, operation in all_blob_clients.items()
            if operation["connected"]
        }
        properties = {
            operation["blob_id"]: operation
            for operation in self.operations
            if operation["kind"] == "properties"
        }
        downloads = {
            operation["blob_id"]: operation
            for operation in self.operations
            if operation["kind"] == "download"
        }
        reads = {
            operation["blob_id"]: operation
            for operation in self.operations
            if operation["kind"] == "read"
        }
        printed: dict[int, set[str]] = {}
        for operation in self.operations:
            if operation["kind"] != "print":
                continue
            for tag in operation["tags"]:
                match = re.fullmatch(r"summary:([^:]+):(\d+)", tag)
                if match:
                    printed.setdefault(int(match.group(2)), set()).add(match.group(1))
        complete_blobs = {
            blob_id
            for blob_id in blob_clients
            if blob_id in properties
            and blob_id in downloads
            and blob_id in reads
            and {"name", "size", "content-type", "tier"} <= printed.get(blob_id, set())
        }
        sync_complete = {
            blob_id
            for blob_id in complete_blobs
            if blob_clients[blob_id]["mode"] == "sync"
        }
        async_complete = {
            blob_id
            for blob_id in complete_blobs
            if blob_clients[blob_id]["mode"] == "async"
            and properties[blob_id]["awaited"]
            and downloads[blob_id]["awaited"]
            and reads[blob_id]["awaited"]
        }

        def call_operations(
            operation: dict[str, Any],
        ) -> list[dict[str, Any]]:
            return self.operations[
                int(operation.get("operation_start", 0)) : int(
                    operation.get("operation_end", 0)
                )
            ]

        def completed_blob_ids(
            operation: dict[str, Any],
            complete: set[int],
        ) -> set[int]:
            return {
                candidate["blob_id"]
                for candidate in call_operations(operation)
                if candidate["kind"] == "blob-client"
                and candidate["blob_id"] in complete
            }

        def genuine_deletion_log(operation: dict[str, Any]) -> bool:
            return any(
                candidate["kind"] == "log"
                and candidate.get("level") in {"info", "warn", "warning"}
                and re.search(r"delet|remov", candidate.get("message", ""), re.I)
                and {
                    "event-subject",
                    "parsed-container",
                    "parsed-blob-name",
                }
                & set(candidate.get("tags", ()))
                for candidate in call_operations(operation)
            )

        def valid_route_profile(
            key: str,
            calls: list[dict[str, Any]],
            complete: set[int],
        ) -> bool:
            target_calls = [call for call in calls if call["target"] == key]
            return any(
                str(call.get("event_type", "")).endswith("BlobCreated")
                and completed_blob_ids(call, complete)
                for call in target_calls
            ) and any(
                str(call.get("event_type", "")).endswith("BlobDeleted")
                and genuine_deletion_log(call)
                for call in target_calls
            )

        valid_sync_routes = {
            key
            for key in sync_routes
            if valid_route_profile(key, sync_route_calls, sync_complete)
        }
        valid_async_routes = {
            key
            for key in async_routes
            if valid_route_profile(key, async_route_calls, async_complete)
        }
        sync_routed_complete = set().union(
            *(
                completed_blob_ids(call, sync_complete)
                for call in sync_route_calls
                if call["target"] in valid_sync_routes
                and str(call.get("event_type", "")).endswith("BlobCreated")
            ),
            set(),
        )
        async_routed_complete = set().union(
            *(
                completed_blob_ids(call, async_complete)
                for call in async_route_calls
                if call["target"] in valid_async_routes
                and str(call.get("event_type", "")).endswith("BlobCreated")
            ),
            set(),
        )
        results["prompt/event-routing"] = bool(valid_sync_routes)
        results["prompt/blob-subject-and-summary"] = bool(sync_routed_complete)

        not_found = {"azure.core.exceptions.ResourceNotFoundError"}
        broad_blob = {
            "azure.core.exceptions.HttpResponseError",
            "azure.core.exceptions.ResourceModifiedError",
            "azure.core.exceptions.AzureError",
        }
        blob_read_operations = [
            operation
            for operation in self.operations
            if operation["kind"] in {"properties", "download", "read"}
        ]
        sync_race = any(
            operation.get("blob_id") in sync_routed_complete
            and self.operation_has_handling(
                operation,
                {"get_blob_properties", "download_blob", "readall", "readinto"},
                not_found,
                broad_blob,
            )
            for operation in blob_read_operations
        )
        async_race = any(
            operation.get("blob_id") in async_routed_complete
            and self.operation_has_handling(
                operation,
                {"get_blob_properties", "download_blob", "readall", "readinto"},
                not_found,
                broad_blob,
            )
            for operation in blob_read_operations
        )
        results["prompt/race-condition-handling"] = sync_race

        custom_events = {
            operation["event_id"]: operation
            for operation in self.operations
            if (
                operation["kind"] == "custom-event"
                and operation["hierarchy"]
                and self.operation_has_provenance(
                    operation,
                    require_subject=True,
                    tag_field="data_tags",
                )
            )
        }
        all_sends = [
            operation for operation in self.operations if operation["kind"] == "send"
        ]
        connected_sends = [
            operation
            for operation in all_sends
            if any(event_id in custom_events for event_id in operation["event_ids"])
            and self.operation_has_provenance(
                operation,
                require_subject=False,
                tag_field="payload_tags",
            )
        ]
        sends = [operation for operation in connected_sends if operation["secure"]]
        publish_broad = {
            "azure.core.exceptions.AzureError",
            "azure.core.exceptions.HttpResponseError",
            "azure.core.exceptions.ClientAuthenticationError",
        }
        sync_sends = [
            operation
            for operation in sends
            if operation["mode"] == "sync"
            and self.operation_has_handling(
                operation,
                {"send"},
                set(),
                publish_broad,
            )
        ]
        async_sends = [
            operation
            for operation in sends
            if operation["mode"] == "async"
            and operation["awaited"]
            and self.operation_has_handling(
                operation,
                {"send"},
                set(),
                publish_broad,
            )
        ]
        results["prompt/custom-event-publishing"] = bool(sync_sends)

        async_closed = {
            operation["client_id"]
            for operation in self.operations
            if operation["kind"] == "close"
            and operation["mode"] == "async"
            and operation["awaited"]
        }
        async_blob_services = {
            operation["client_id"]
            for operation in self.operations
            if operation["kind"] == "blob-service"
            and operation["mode"] == "async"
            and operation["secure"]
        }
        async_publishers = {
            operation["client_id"]
            for operation in self.operations
            if operation["kind"] == "publisher-client"
            and operation["mode"] == "async"
            and operation["secure"]
        }
        results["prompt/async-implementations"] = (
            async_schemas == {"eventgrid", "cloud"}
            and bool(valid_async_routes)
            and bool(async_routed_complete)
            and async_race
            and bool(async_sends)
            and bool(async_blob_services & async_closed)
            and bool(async_publishers & async_closed)
        )

        results["prompt/secure-client-configuration"] = (
            any(
                blob_clients[blob_id]["mode"] == "sync"
                and blob_clients[blob_id]["secure"]
                for blob_id in sync_routed_complete
            )
            and any(
                blob_clients[blob_id]["mode"] == "async"
                and blob_clients[blob_id]["secure"]
                for blob_id in async_routed_complete
            )
            and any(
                operation["mode"] == "sync" and operation["secure"]
                for operation in connected_sends
            )
            and any(
                operation["mode"] == "async" and operation["secure"]
                for operation in connected_sends
            )
            and all(
                all_blob_clients[blob_id]["secure"]
                for blob_id in set(properties) | set(downloads) | set(reads)
                if blob_id in all_blob_clients
            )
            and all(operation["secure"] for operation in all_sends)
            and not self.insecure_auth_present()
        )

        kinds = []
        for operation in self.operations:
            if operation["kind"] == "event-call" and operation["target"] in routes:
                kinds.append(
                    (
                        "async" if operation["async"] else "sync",
                        operation["schema"],
                        operation.get("event_type"),
                    )
                )
            elif operation["kind"] == "send" and operation in sends:
                kinds.append(
                    (
                        "async" if operation["mode"] == "async" else "sync",
                        "publish",
                        None,
                    )
                )
        required_types = {
            ("eventgrid", "Microsoft.Storage.BlobCreated"),
            ("eventgrid", "Microsoft.Storage.BlobDeleted"),
            ("cloud", "Microsoft.Storage.BlobCreated"),
            ("cloud", "Microsoft.Storage.BlobDeleted"),
        }
        workflow_operations = [
            operation
            for operation in self.operations
            if (
                operation["kind"] == "event-call"
                and operation["target"] in valid_sync_routes | valid_async_routes
                and self.connected_demo_sample(operation)
            )
            or (operation["kind"] == "send" and operation in sends)
        ]

        def operation_key(operation: dict[str, Any]) -> tuple[str, str, str | None]:
            if operation["kind"] == "send":
                return operation["mode"], "publish", None
            return (
                "async" if operation["async"] else "sync",
                operation["schema"],
                operation.get("event_type"),
            )

        required_keys = [
            *(("sync", schema, event_type) for schema, event_type in required_types),
            ("sync", "publish", None),
            *(("async", schema, event_type) for schema, event_type in required_types),
            ("async", "publish", None),
        ]
        candidates = [
            [
                operation
                for operation in workflow_operations
                if operation_key(operation) == key
            ]
            for key in required_keys
        ]

        def compatible(
            constraints: dict[int, bool | str],
            operation: dict[str, Any],
        ) -> dict[int, bool | str] | None:
            merged = dict(constraints)
            for branch, choice in operation["path"]:
                if branch in merged and merged[branch] != choice:
                    return None
                merged[branch] = choice
            return merged

        def ordered(selection: list[dict[str, Any]]) -> bool:
            sync_receives = [
                operation["sequence"]
                for operation in selection
                if operation_key(operation)[0] == "sync"
                and operation["kind"] == "event-call"
            ]
            async_receives = [
                operation["sequence"]
                for operation in selection
                if operation_key(operation)[0] == "async"
                and operation["kind"] == "event-call"
            ]
            sync_publish = next(
                operation["sequence"]
                for operation in selection
                if operation_key(operation) == ("sync", "publish", None)
            )
            async_publish = next(
                operation["sequence"]
                for operation in selection
                if operation_key(operation) == ("async", "publish", None)
            )
            return (
                max(sync_receives) < sync_publish
                and sync_publish < min(async_receives)
                and max(async_receives) < async_publish
            )

        def find_flow(
            index: int,
            selection: list[dict[str, Any]],
            constraints: dict[int, bool | str],
        ) -> bool:
            if index == len(candidates):
                return ordered(selection)
            for operation in candidates[index]:
                merged = compatible(constraints, operation)
                if merged is not None and find_flow(
                    index + 1,
                    selection + [operation],
                    merged,
                ):
                    return True
            return False

        results["prompt/ordered-demo-workflow"] = all(candidates) and find_flow(
            0, [], {}
        )
        return results


def main() -> int:
    payload = json.load(sys.stdin)
    if "--discover" in sys.argv[1:]:
        print(
            json.dumps(
                discover_application_paths(
                    payload.get("documents", []),
                    payload.get("applicationPaths", []),
                )
            )
        )
        return 0
    documents = payload.get("documents", [])
    manifests = payload.get("dependencyManifests", [])
    application_roots = payload.get("applicationRoots", [])
    analyzer = Analyzer(documents, application_roots)
    print(json.dumps(analyzer.evaluate(manifests), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
