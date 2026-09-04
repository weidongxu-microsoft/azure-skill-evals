from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from typing import Any
from urllib.parse import unquote, urlparse
from uuid import uuid4

import httpx
from azure.core.exceptions import ClientAuthenticationError, HttpResponseError

from .foundry import FoundryHttpError
from .models import EvaluationCase
from .service import SupportAssistant, SupportAssistantError

_LOGGER = logging.getLogger("contoso.support")
_MESSAGE_PATH = re.compile(r"^/conversations/([^/]+)/messages$")
_FEEDBACK_PATH = re.compile(r"^/conversations/([^/]+)/feedback$")
_OPERATION_PATH = re.compile(r"^/admin/operations/([^/]+)$")
_MAX_BODY_BYTES = 1024 * 1024


@dataclass(slots=True)
class ServerOptions:
    require_authentication: bool
    admin_principal_ids: frozenset[str]
    materials: tuple[Path, ...]
    evaluation_dataset: Path


@dataclass(slots=True)
class OperationRecord:
    status: str
    result: object | None = None
    error: str | None = None


class SupportHttpServer(ThreadingHTTPServer):
    def __init__(
        self,
        address: tuple[str, int],
        assistant: SupportAssistant,
        options: ServerOptions,
    ) -> None:
        self.assistant = assistant
        self.options = options
        self.operations: dict[str, OperationRecord] = {}
        self.operations_lock = Lock()
        self.executor = ThreadPoolExecutor(max_workers=2)
        super().__init__(address, SupportRequestHandler)

    def server_close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=False)
        super().server_close()


class SupportRequestHandler(BaseHTTPRequestHandler):
    server: SupportHttpServer

    def do_GET(self) -> None:
        self._dispatch()

    def do_POST(self) -> None:
        self._dispatch()

    def do_DELETE(self) -> None:
        self._dispatch()

    def log_message(self, message: str, *args: object) -> None:
        _LOGGER.info(message, *args)

    def _dispatch(self) -> None:
        try:
            status, body = self._route()
        except HttpProblem as error:
            status, body = error.status, {"error": str(error)}
        except SupportAssistantError as error:
            status = (
                HTTPStatus.NOT_FOUND
                if error.code == "response_not_found"
                else HTTPStatus.CONFLICT
            )
            body = {"error": str(error), "code": error.code}
        except FoundryHttpError as error:
            status = HTTPStatus.BAD_GATEWAY
            body = {
                "error": str(error),
                "azureStatus": error.status_code,
                "azureCode": error.error_code,
            }
        except ClientAuthenticationError as error:
            status = HTTPStatus.BAD_GATEWAY
            body = {"error": str(error), "azureCode": "authentication_failed"}
        except HttpResponseError as error:
            status = HTTPStatus.BAD_GATEWAY
            body = {
                "error": str(error),
                "azureStatus": getattr(error, "status_code", None),
                "azureCode": getattr(error, "error_code", None),
            }
        except httpx.RequestError as error:
            status = HTTPStatus.BAD_GATEWAY
            body = {"error": str(error), "azureCode": "transport_error"}
        except TimeoutError as error:
            status = HTTPStatus.GATEWAY_TIMEOUT
            body = {"error": str(error), "azureCode": "timeout"}
        except ExceptionGroup as error:
            _LOGGER.exception("Request cleanup failed")
            status = HTTPStatus.INTERNAL_SERVER_ERROR
            body = {"error": str(error)}
        except (OSError, RuntimeError, ValueError) as error:
            _LOGGER.exception("Request failed")
            status, body = HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)}
        self._send_json(status, body)

    def _route(self) -> tuple[HTTPStatus, object]:
        path = urlparse(self.path).path
        if self.command == "GET" and path == "/health":
            return HTTPStatus.OK, {"status": "ok"}
        principal_id = self._principal_id()
        if path.startswith("/admin/"):
            self._require_admin(principal_id)
        if self.command == "POST" and path == "/admin/ingest":
            self.server.assistant.ingest(self.server.options.materials)
            return HTTPStatus.CREATED, {"status": "ingested"}
        if match := _MESSAGE_PATH.fullmatch(path):
            self._require_method("POST")
            question = _required_string(self._read_json(), "question")
            answer = self.server.assistant.ask(
                principal_id, unquote(match.group(1)), question
            )
            return HTTPStatus.OK, asdict(answer)
        if match := _FEEDBACK_PATH.fullmatch(path):
            self._require_method("POST")
            body = self._read_json()
            self.server.assistant.record_feedback(
                principal_id,
                unquote(match.group(1)),
                _required_string(body, "responseId"),
                _required_string(body, "rating"),
                _optional_string(body, "comment"),
            )
            return HTTPStatus.CREATED, {"status": "recorded"}
        if self.command == "GET" and path == "/admin/unresolved":
            return HTTPStatus.OK, {
                "items": [
                    asdict(item)
                    for item in self.server.assistant.unresolved_questions()
                ]
            }
        if self.command == "POST" and path == "/admin/evaluations":
            operation_id = self._start_evaluation()
            return HTTPStatus.ACCEPTED, {"operationId": operation_id}
        if match := _OPERATION_PATH.fullmatch(path):
            self._require_method("GET")
            operation_id = unquote(match.group(1))
            with self.server.operations_lock:
                operation = self.server.operations.get(operation_id)
            if operation is None:
                raise HttpProblem(HTTPStatus.NOT_FOUND, "Operation not found.")
            return HTTPStatus.OK, asdict(operation)
        if self.command == "DELETE" and path == "/admin/resources":
            with self.server.operations_lock:
                running = any(
                    item.status == "running"
                    for item in self.server.operations.values()
                )
            if running:
                raise HttpProblem(
                    HTTPStatus.CONFLICT,
                    "Wait for active evaluations before cleanup.",
                )
            self.server.assistant.cleanup()
            return HTTPStatus.OK, {"status": "deleted"}
        raise HttpProblem(HTTPStatus.NOT_FOUND, "Route not found.")

    def _start_evaluation(self) -> str:
        operation_id = str(uuid4())
        with self.server.operations_lock:
            self.server.operations[operation_id] = OperationRecord("running")

        def run() -> None:
            try:
                result = [
                    asdict(item)
                    for item in self.server.assistant.evaluate(
                        _load_evaluation_cases(
                            self.server.options.evaluation_dataset
                        )
                    )
                ]
                record = OperationRecord("completed", result=result)
            except (
                ClientAuthenticationError,
                ExceptionGroup,
                HttpResponseError,
                httpx.RequestError,
                OSError,
                RuntimeError,
                SupportAssistantError,
                TimeoutError,
                ValueError,
            ) as error:
                _LOGGER.exception("Evaluation failed")
                record = OperationRecord("failed", error=str(error))
            with self.server.operations_lock:
                self.server.operations[operation_id] = record

        self.server.executor.submit(run)
        return operation_id

    def _principal_id(self) -> str:
        if not self.server.options.require_authentication:
            return self.headers.get("X-MS-CLIENT-PRINCIPAL-ID", "test-user")
        principal_id = self.headers.get("X-MS-CLIENT-PRINCIPAL-ID", "").strip()
        if not principal_id:
            raise HttpProblem(
                HTTPStatus.UNAUTHORIZED,
                "Microsoft Entra authentication is required.",
            )
        return principal_id

    def _require_admin(self, principal_id: str) -> None:
        if principal_id not in self.server.options.admin_principal_ids:
            raise HttpProblem(
                HTTPStatus.FORBIDDEN, "Administrator access is required."
            )

    def _require_method(self, method: str) -> None:
        if self.command != method:
            raise HttpProblem(HTTPStatus.METHOD_NOT_ALLOWED, "Method not allowed.")

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > _MAX_BODY_BYTES:
            raise HttpProblem(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "Request body exceeds 1 MiB.",
            )
        try:
            value = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as error:
            raise HttpProblem(
                HTTPStatus.BAD_REQUEST, "Request body contains invalid JSON."
            ) from error
        if not isinstance(value, dict):
            raise HttpProblem(
                HTTPStatus.BAD_REQUEST, "Request body must be a JSON object."
            )
        return value

    def _send_json(self, status: HTTPStatus, body: object) -> None:
        content = (json.dumps(body, default=str) + "\n").encode()
        self.send_response(status.value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


class HttpProblem(Exception):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status


def create_server(
    assistant: SupportAssistant,
    options: ServerOptions,
    *,
    host: str = "127.0.0.1",
    port: int = 0,
) -> SupportHttpServer:
    return SupportHttpServer((host, port), assistant, options)


def _load_evaluation_cases(path: Path) -> list[EvaluationCase]:
    cases: list[EvaluationCase] = []
    with path.open(encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            try:
                value = json.loads(line)
                cases.append(
                    EvaluationCase(
                        case_id=_required_string(value, "id"),
                        query=_required_string(value, "query"),
                        ground_truth=_required_string(value, "groundTruth"),
                    )
                )
            except (json.JSONDecodeError, HttpProblem) as error:
                raise ValueError(
                    f"Invalid evaluation case at {path}:{line_number}."
                ) from error
    if not cases:
        raise ValueError(f"Evaluation dataset is empty: {path}")
    return cases


def _required_string(body: dict[str, Any], key: str) -> str:
    value = _optional_string(body, key)
    if value is None:
        raise HttpProblem(HTTPStatus.BAD_REQUEST, f"{key} is required.")
    return value


def _optional_string(body: dict[str, Any], key: str) -> str | None:
    value = body.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise HttpProblem(
            HTTPStatus.BAD_REQUEST, f"{key} must be a non-empty string."
        )
    return value.strip()
