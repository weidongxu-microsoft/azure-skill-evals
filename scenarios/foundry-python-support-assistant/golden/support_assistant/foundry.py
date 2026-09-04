from __future__ import annotations

import time
from collections.abc import Iterator, Sequence
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote

import httpx
from azure.core.credentials import TokenCredential
from azure.core.exceptions import ClientAuthenticationError, HttpResponseError

from .models import (
    Citation,
    EvaluationMetric,
    FoundryResources,
    GatewayAnswer,
)

JsonObject = dict[str, Any]


class SupportGateway(Protocol):
    def ingest(self, document_paths: Sequence[Path]) -> FoundryResources: ...

    def ask(
        self,
        resources: FoundryResources,
        conversation_id: str | None,
        question: str,
    ) -> GatewayAnswer: ...

    def delete_conversation(self, conversation_id: str) -> None: ...

    def rollback_turn(self, conversation_id: str, item_ids: Sequence[str]) -> None: ...

    def run_evaluation(
        self, rows: Sequence[JsonObject]
    ) -> list[EvaluationMetric]: ...

    def cleanup(
        self, resources: FoundryResources, conversation_ids: Sequence[str]
    ) -> None: ...


class FoundryHttpError(HttpResponseError):
    def __init__(self, status_code: int, error_code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code


class FoundryRestGateway:
    _file_terminal_statuses = frozenset({"completed", "failed", "cancelled"})
    _evaluation_terminal_statuses = frozenset(
        {"completed", "failed", "cancelled", "canceled"}
    )

    def __init__(
        self,
        project_endpoint: str,
        credential: TokenCredential,
        model_deployment_name: str,
        evaluation_model_deployment_name: str,
        token_scope: str,
        *,
        poll_interval_seconds: float = 2.0,
        timeout_seconds: float = 600.0,
        client: httpx.Client | None = None,
    ) -> None:
        self._base_url = f"{project_endpoint.rstrip('/')}/openai/v1"
        self._credential = credential
        self._model = model_deployment_name
        self._evaluation_model = evaluation_model_deployment_name
        self._token_scope = token_scope
        self._poll_interval = poll_interval_seconds
        self._timeout = timeout_seconds
        self._client = client or httpx.Client(timeout=60)
        self._owns_client = client is None

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def ingest(self, document_paths: Sequence[Path]) -> FoundryResources:
        if not document_paths:
            raise ValueError("At least one product document is required.")
        vector_store = self._request(
            "POST",
            "/vector_stores",
            json_body={"name": f"contoso-support-{int(time.time())}"},
        )
        vector_store_id = _required_string(vector_store, "id")
        file_ids: list[str] = []
        resources = FoundryResources(vector_store_id, file_ids)
        try:
            for document_path in document_paths:
                with document_path.open("rb") as content:
                    uploaded = self._request(
                        "POST",
                        "/files",
                        data={"purpose": "assistants"},
                        files={
                            "file": (
                                document_path.name,
                                content,
                                "text/markdown",
                            )
                        },
                    )
                file_id = _required_string(uploaded, "id")
                file_ids.append(file_id)
                attached = self._request(
                    "POST",
                    f"/vector_stores/{_path(vector_store_id)}/files",
                    json_body={"file_id": file_id},
                )
                attached_id = _required_string(attached, "id")
                status = self._poll_vector_store_file(
                    vector_store_id, attached_id
                )
                if status != "completed":
                    raise RuntimeError(
                        f"Indexing {document_path.name} ended with status {status}."
                    )
            return FoundryResources(vector_store_id, list(file_ids))
        except (
            ClientAuthenticationError,
            HttpResponseError,
            httpx.RequestError,
            OSError,
            RuntimeError,
            TimeoutError,
            ValueError,
        ) as error:
            try:
                self.cleanup(resources, [])
            except (
                ClientAuthenticationError,
                ExceptionGroup,
                HttpResponseError,
                httpx.RequestError,
                RuntimeError,
                TimeoutError,
            ) as cleanup_error:
                raise ExceptionGroup(
                    "Ingestion failed and created resources were not fully deleted.",
                    [error, cleanup_error],
                ) from error
            raise

    def ask(
        self,
        resources: FoundryResources,
        conversation_id: str | None,
        question: str,
    ) -> GatewayAnswer:
        active_conversation_id = conversation_id
        created_conversation = False
        if active_conversation_id is None:
            conversation = self._request("POST", "/conversations", json_body={})
            active_conversation_id = _required_string(conversation, "id")
            created_conversation = True
        try:
            before_ids = set(self._conversation_item_ids(active_conversation_id))
        except (
            ClientAuthenticationError,
            HttpResponseError,
            httpx.RequestError,
            RuntimeError,
            TimeoutError,
            ValueError,
        ) as error:
            if not created_conversation:
                raise
            try:
                self._delete_conversation_record(active_conversation_id)
            except (
                ClientAuthenticationError,
                HttpResponseError,
                httpx.RequestError,
                RuntimeError,
                TimeoutError,
            ) as cleanup_error:
                raise ExceptionGroup(
                    "The new conversation baseline could not be loaded and "
                    "the conversation could not be deleted.",
                    [error, cleanup_error],
                ) from error
            raise
        try:
            response = self._request(
                "POST",
                "/responses",
                json_body={
                    "model": self._model,
                    "conversation": active_conversation_id,
                    "input": question,
                    "instructions": (
                        "You are Contoso's internal product-support assistant. "
                        "Search the indexed product documentation before answering. "
                        "Answer only from retrieved documentation. If it does not "
                        "support an answer, begin with 'UNSUPPORTED:'. Preserve "
                        "file citations for supported answers."
                    ),
                    "tools": [
                        {
                            "type": "file_search",
                            "vector_store_ids": [resources.vector_store_id],
                            "max_num_results": 10,
                        }
                    ],
                    "tool_choice": "required",
                    "include": ["file_search_call.results"],
                },
            )
            status = _required_string(response, "status")
            if status != "completed":
                raise RuntimeError(
                    f"Foundry response ended with status {status}."
                )
            after_ids = set(self._conversation_item_ids(active_conversation_id))
            turn_item_ids = sorted(after_ids - before_ids)
            text, citations, retrieved_context = _parse_response(response)
            return GatewayAnswer(
                conversation_id=active_conversation_id,
                response_id=_required_string(response, "id"),
                text=text,
                citations=citations,
                supported=bool(citations)
                and not text.upper().startswith("UNSUPPORTED:"),
                turn_item_ids=turn_item_ids,
                retrieved_context=retrieved_context,
            )
        except (
            ClientAuthenticationError,
            HttpResponseError,
            httpx.RequestError,
            RuntimeError,
            TimeoutError,
            ValueError,
        ) as error:
            try:
                if created_conversation:
                    self._delete_conversation_record(active_conversation_id)
                else:
                    current_ids = set(
                        self._conversation_item_ids(active_conversation_id)
                    )
                    self.rollback_turn(
                        active_conversation_id,
                        sorted(current_ids - before_ids),
                    )
            except (
                ClientAuthenticationError,
                ExceptionGroup,
                HttpResponseError,
                httpx.RequestError,
                RuntimeError,
                TimeoutError,
            ) as cleanup_error:
                raise ExceptionGroup(
                    "The answer failed and conversation changes were not rolled back.",
                    [error, cleanup_error],
                ) from error
            raise

    def delete_conversation(self, conversation_id: str) -> None:
        self.rollback_turn(
            conversation_id, list(self._conversation_item_ids(conversation_id))
        )
        self._delete_conversation_record(conversation_id)

    def rollback_turn(
        self, conversation_id: str, item_ids: Sequence[str]
    ) -> None:
        failures: list[Exception] = []
        for item_id in item_ids:
            try:
                self._request(
                    "DELETE",
                    f"/conversations/{_path(conversation_id)}/items/{_path(item_id)}",
                )
            except FoundryHttpError as error:
                if error.status_code != 404:
                    failures.append(error)
            except (
                ClientAuthenticationError,
                httpx.RequestError,
                TimeoutError,
            ) as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("Conversation rollback failed.", failures)

    def run_evaluation(
        self, rows: Sequence[JsonObject]
    ) -> list[EvaluationMetric]:
        if not rows:
            raise ValueError("At least one evaluation row is required.")
        criteria = [
            {
                "type": "azure_ai_evaluator",
                "name": "groundedness",
                "evaluator_name": "builtin.groundedness",
                "initialization_parameters": {
                    "deployment_name": self._evaluation_model
                },
                "data_mapping": {
                    "query": "{{item.query}}",
                    "response": "{{item.response}}",
                    "context": "{{item.context}}",
                },
            },
            {
                "type": "azure_ai_evaluator",
                "name": "relevance",
                "evaluator_name": "builtin.relevance",
                "initialization_parameters": {
                    "deployment_name": self._evaluation_model
                },
                "data_mapping": {
                    "query": "{{item.query}}",
                    "response": "{{item.response}}",
                },
            },
        ]
        evaluation = self._request(
            "POST",
            "/evals",
            json_body={
                "name": f"contoso-support-{int(time.time())}",
                "data_source_config": {
                    "type": "custom",
                    "item_schema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "response": {"type": "string"},
                            "context": {"type": "string"},
                            "ground_truth": {"type": "string"},
                        },
                        "required": [
                            "query",
                            "response",
                            "context",
                            "ground_truth",
                        ],
                    },
                    "include_sample_schema": True,
                },
                "testing_criteria": criteria,
            },
        )
        evaluation_id = _required_string(evaluation, "id")
        evaluation_error: Exception | None = None
        metrics: list[EvaluationMetric] = []
        try:
            run = self._request(
                "POST",
                f"/evals/{_path(evaluation_id)}/runs",
                json_body={
                    "name": f"contoso-support-run-{int(time.time())}",
                    "data_source": {
                        "type": "jsonl",
                        "source": {
                            "type": "file_content",
                            "content": [{"item": row} for row in rows],
                        },
                    },
                },
            )
            run_id = _required_string(run, "id")
            deadline = time.monotonic() + self._timeout
            status = _required_string(run, "status")
            while status not in self._evaluation_terminal_statuses:
                self._delay_until(deadline, f"Evaluation run {run_id}")
                run = self._request(
                    "GET",
                    f"/evals/{_path(evaluation_id)}/runs/{_path(run_id)}",
                )
                status = _required_string(run, "status")
            if status != "completed":
                raise RuntimeError(
                    f"Evaluation run {run_id} ended with status {status}."
                )
            path = (
                f"/evals/{_path(evaluation_id)}/runs/{_path(run_id)}"
                "/output_items?limit=100"
            )
            for item in self._paged_data(path):
                item_id = _required_string(item, "id")
                item_status = _required_string(item, "status")
                results = item.get("results", [])
                if not isinstance(results, list):
                    raise ValueError("Evaluation item results must be an array.")
                for result in results:
                    if not isinstance(result, dict):
                        raise ValueError("Evaluation result must be an object.")
                    metrics.append(
                        EvaluationMetric(
                            item_id=item_id,
                            item_status=item_status,
                            name=_required_string(result, "name"),
                            score=_optional_number(result.get("score")),
                            passed=_optional_bool(result.get("passed")),
                        )
                    )
        except (
            ClientAuthenticationError,
            HttpResponseError,
            httpx.RequestError,
            RuntimeError,
            TimeoutError,
            ValueError,
        ) as error:
            evaluation_error = error
        finally:
            cleanup_error: Exception | None = None
            try:
                self._request("DELETE", f"/evals/{_path(evaluation_id)}")
            except (
                ClientAuthenticationError,
                HttpResponseError,
                httpx.RequestError,
                RuntimeError,
                TimeoutError,
            ) as error:
                cleanup_error = error
            if evaluation_error is not None and cleanup_error is not None:
                raise ExceptionGroup(
                    "Evaluation failed and its definition could not be deleted.",
                    [evaluation_error, cleanup_error],
                )
            if cleanup_error is not None:
                raise cleanup_error
        if evaluation_error is not None:
            raise evaluation_error
        return metrics

    def cleanup(
        self, resources: FoundryResources, conversation_ids: Sequence[str]
    ) -> None:
        failures: list[Exception] = []
        for conversation_id in dict.fromkeys(conversation_ids):
            self._delete_for_cleanup(
                lambda item=conversation_id: self.delete_conversation(item),
                failures,
            )
        self._raise_cleanup_failures(failures)
        self._delete_for_cleanup(
            lambda: self._request(
                "DELETE",
                f"/vector_stores/{_path(resources.vector_store_id)}",
            ),
            failures,
        )
        self._raise_cleanup_failures(failures)
        for file_id in resources.file_ids:
            self._delete_for_cleanup(
                lambda item=file_id: self._request(
                    "DELETE", f"/files/{_path(item)}"
                ),
                failures,
            )
        self._raise_cleanup_failures(failures)

    def _delete_for_cleanup(
        self, operation: Any, failures: list[Exception]
    ) -> None:
        try:
            operation()
        except FoundryHttpError as error:
            if error.status_code != 404:
                failures.append(error)
        except (
            ClientAuthenticationError,
            ExceptionGroup,
            httpx.RequestError,
            RuntimeError,
            TimeoutError,
        ) as error:
            failures.append(error)

    @staticmethod
    def _raise_cleanup_failures(failures: list[Exception]) -> None:
        if failures:
            raise ExceptionGroup(
                "Some Foundry resources were not deleted.", failures
            )

    def _poll_vector_store_file(
        self, vector_store_id: str, file_id: str
    ) -> str:
        deadline = time.monotonic() + self._timeout
        while True:
            value = self._request(
                "GET",
                f"/vector_stores/{_path(vector_store_id)}/files/{_path(file_id)}",
            )
            status = _required_string(value, "status")
            if status in self._file_terminal_statuses:
                return status
            self._delay_until(deadline, f"Vector-store file {file_id}")

    def _delay_until(self, deadline: float, operation: str) -> None:
        if time.monotonic() >= deadline:
            raise TimeoutError(f"{operation} did not finish within {self._timeout}s.")
        time.sleep(self._poll_interval)

    def _conversation_item_ids(self, conversation_id: str) -> Iterator[str]:
        path = f"/conversations/{_path(conversation_id)}/items?limit=100"
        for item in self._paged_data(path):
            yield _required_string(item, "id")

    def _delete_conversation_record(self, conversation_id: str) -> None:
        try:
            self._request("DELETE", f"/conversations/{_path(conversation_id)}")
        except FoundryHttpError as error:
            if error.status_code != 404:
                raise

    def _paged_data(self, path: str) -> Iterator[JsonObject]:
        next_path: str | None = path
        while next_path is not None:
            page = self._request("GET", next_path)
            data = page.get("data")
            if not isinstance(data, list):
                raise ValueError("Paged response data must be an array.")
            for item in data:
                if not isinstance(item, dict):
                    raise ValueError("Paged response item must be an object.")
                yield item
            if page.get("has_more") is True:
                last_id = _required_string(page, "last_id")
                separator = "&" if "?" in path else "?"
                next_path = f"{path}{separator}after={quote(last_id, safe='')}"
            else:
                next_path = None

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: JsonObject | None = None,
        data: dict[str, str] | None = None,
        files: dict[str, tuple[str, Any, str]] | None = None,
    ) -> JsonObject:
        token = self._credential.get_token(self._token_scope)
        response = self._client.request(
            method,
            f"{self._base_url}{path}",
            headers={"authorization": f"Bearer {token.token}"},
            json=json_body,
            data=data,
            files=files,
        )
        if response.status_code >= 400:
            error_code, message = _service_error(response)
            raise FoundryHttpError(response.status_code, error_code, message)
        if response.status_code == 204 or not response.content:
            return {}
        value = response.json()
        if not isinstance(value, dict):
            raise ValueError("Foundry response must be a JSON object.")
        return value


def _parse_response(
    response: JsonObject,
) -> tuple[str, list[Citation], list[str]]:
    text_parts: list[str] = []
    citations: dict[str, Citation] = {}
    context: list[str] = []
    output = response.get("output")
    if not isinstance(output, list):
        raise ValueError("Foundry response output must be an array.")
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "file_search_call":
            results = item.get("results", [])
            if isinstance(results, list):
                context.extend(
                    result["text"].strip()
                    for result in results
                    if isinstance(result, dict)
                    and isinstance(result.get("text"), str)
                    and result["text"].strip()
                )
        if item.get("type") != "message":
            continue
        content = item.get("content", [])
        if not isinstance(content, list):
            continue
        for part in content:
            if not isinstance(part, dict) or part.get("type") != "output_text":
                continue
            part_text = part.get("text")
            if isinstance(part_text, str):
                text_parts.append(part_text)
            annotations = part.get("annotations", [])
            if not isinstance(annotations, list):
                continue
            for annotation in annotations:
                if (
                    isinstance(annotation, dict)
                    and annotation.get("type") == "file_citation"
                ):
                    file_id = _required_string(annotation, "file_id")
                    citations[file_id] = Citation(
                        file_id=file_id,
                        filename=_required_string(annotation, "filename"),
                    )
    text = "".join(text_parts).strip()
    if not text:
        raise ValueError("Foundry response contained no output text.")
    return text, list(citations.values()), context


def _service_error(response: httpx.Response) -> tuple[str, str]:
    code = "unknown"
    message = response.text
    try:
        value = response.json()
        if isinstance(value, dict):
            error = value.get("error", value)
            if isinstance(error, dict):
                if isinstance(error.get("code"), str):
                    code = error["code"]
                if isinstance(error.get("message"), str):
                    message = error["message"]
    except ValueError:
        pass
    return (
        code,
        "Foundry request failed: "
        f"status={response.status_code} code={code} message={message}",
    )


def _required_string(value: JsonObject, key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str):
        raise ValueError(f"Foundry property {key} must be a string.")
    return item


def _optional_number(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, int | float):
        return float(value)
    raise ValueError("Evaluation score must be numeric or null.")


def _optional_bool(value: object) -> bool | None:
    if value is None or isinstance(value, bool):
        return value
    raise ValueError("Evaluation passed must be boolean or null.")


def _path(value: str) -> str:
    return quote(value, safe="")
