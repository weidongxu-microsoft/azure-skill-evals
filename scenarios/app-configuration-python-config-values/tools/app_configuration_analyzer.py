from __future__ import annotations

import ast
import json
import sys
from typing import Any


FILTER = "app:Settings:*"


def literal_string(node: ast.AST, values: dict[str, str]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return values.get(node.id)
    return None


def call_method(node: ast.AST, method: str) -> ast.Call | None:
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == method
    ):
        return node
    return None


def printed_result_value(node: ast.AST, result_names: set[str]) -> bool:
    return any(
        isinstance(child, ast.Attribute)
        and child.attr == "value"
        and isinstance(child.value, ast.Name)
        and child.value.id in result_names
        for child in ast.walk(node)
    )


def analyze_statements(
    statements: list[ast.stmt],
    inherited_values: dict[str, str],
) -> tuple[bool, bool]:
    values = dict(inherited_values)
    result_names: set[str] = set()
    has_filtered_list = False
    has_get_output = False

    for statement in statements:
        if isinstance(statement, (ast.Assign, ast.AnnAssign)):
            targets = (
                statement.targets
                if isinstance(statement, ast.Assign)
                else [statement.target]
            )
            value = statement.value
            if value is not None:
                resolved = literal_string(value, values)
                for target in targets:
                    if isinstance(target, ast.Name) and resolved is not None:
                        values[target.id] = resolved
                if call_method(value, "get_configuration_setting"):
                    result_names.update(
                        target.id
                        for target in targets
                        if isinstance(target, ast.Name)
                    )
                if isinstance(value, ast.Name) and value.id in result_names:
                    result_names.update(
                        target.id
                        for target in targets
                        if isinstance(target, ast.Name)
                    )

        for call in (
            child for child in ast.walk(statement) if isinstance(child, ast.Call)
        ):
            listing = call_method(call, "list_configuration_settings")
            if listing is not None:
                filter_node = next(
                    (
                        keyword.value
                        for keyword in listing.keywords
                        if keyword.arg == "key_filter"
                    ),
                    listing.args[0] if listing.args else None,
                )
                if (
                    filter_node is not None
                    and literal_string(filter_node, values) == FILTER
                ):
                    has_filtered_list = True
            if (
                isinstance(call.func, ast.Name)
                and call.func.id == "print"
                and any(
                    printed_result_value(argument, result_names)
                    for argument in [
                        *call.args,
                        *(keyword.value for keyword in call.keywords),
                    ]
                )
            ):
                has_get_output = True

        nested: list[list[ast.stmt]] = []
        if isinstance(statement, ast.If):
            nested.extend((statement.body, statement.orelse))
        elif isinstance(statement, (ast.For, ast.AsyncFor, ast.While)):
            nested.extend((statement.body, statement.orelse))
        elif isinstance(statement, (ast.With, ast.AsyncWith)):
            nested.append(statement.body)
        elif isinstance(statement, ast.Try):
            nested.extend(
                [
                    statement.body,
                    statement.orelse,
                    statement.finalbody,
                    *(handler.body for handler in statement.handlers),
                ]
            )
        for block in nested:
            nested_list, nested_output = analyze_statements(block, values)
            has_filtered_list = has_filtered_list or nested_list
            has_get_output = has_get_output or nested_output

    return has_filtered_list, has_get_output


def analyze(source: str) -> dict[str, bool]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {"get_list_settings": False}

    module_values: dict[str, str] = {}
    for statement in tree.body:
        if isinstance(statement, (ast.Assign, ast.AnnAssign)):
            targets = (
                statement.targets
                if isinstance(statement, ast.Assign)
                else [statement.target]
            )
            if statement.value is None:
                continue
            value = literal_string(statement.value, module_values)
            if value is not None:
                for target in targets:
                    if isinstance(target, ast.Name):
                        module_values[target.id] = value

    evidence = [analyze_statements(tree.body, module_values)]
    evidence.extend(
        analyze_statements(node.body, module_values)
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    )
    return {
        "get_list_settings": any(filtered for filtered, _output in evidence)
        and any(output for _filtered, output in evidence)
    }


request: dict[str, Any] = json.load(sys.stdin)
print(json.dumps(analyze(str(request.get("source", "")))))
