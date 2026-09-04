from __future__ import annotations

import json
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import httpx
from azure.core.credentials import AccessToken, TokenCredential
from azure.core.exceptions import (
    ClientAuthenticationError,
    ServiceRequestError,
    ServiceResponseError,
)

from support_assistant.foundry import (
    FoundryRestGateway,
    JsonObject,
)
from support_assistant.models import (
    AssistantState,
    Citation,
    EvaluationCase,
    EvaluationMetric,
    FoundryResources,
    GatewayAnswer,
    state_from_dict,
)
from support_assistant.server import ServerOptions, create_server
from support_assistant.service import SupportAssistant, SupportAssistantError
from support_assistant.state import MemoryStateStore

RESOURCES = FoundryResources(
    "vector-store-1",
    ["file-1"],
    "contoso-product-support-test",
    "1",
)


class SupportAssistantTests(unittest.TestCase):
    def test_ingestion_creates_prompt_agent_after_retrieval_is_ready(
        self,
    ) -> None:
        project_client = FakeProjectClient()

        def handle(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path.endswith(
                "/vector_stores"
            ):
                return httpx.Response(
                    200, json={"id": "vector-store-1"}, request=request
                )
            if request.method == "POST" and request.url.path.endswith(
                "/vector_stores/vector-store-1/files"
            ):
                return httpx.Response(
                    200, json={"id": "attached-1"}, request=request
                )
            if request.method == "POST" and request.url.path.endswith("/files"):
                return httpx.Response(
                    200, json={"id": "file-1"}, request=request
                )
            if request.method == "GET" and request.url.path.endswith(
                "/vector_stores/vector-store-1/files/attached-1"
            ):
                return httpx.Response(
                    200, json={"status": "completed"}, request=request
                )
            self.fail(f"Unexpected request: {request.method} {request.url}")

        with (
            TemporaryDirectory() as directory,
            httpx.Client(transport=httpx.MockTransport(handle)) as client,
        ):
            document = Path(directory, "manual.md")
            document.write_text("Product documentation.", encoding="utf-8")
            gateway = FoundryRestGateway(
                "https://example.test/api/projects/support",
                FakeCredential(),
                "answer-model",
                "evaluation-model",
                "https://ai.azure.com/.default",
                client=client,
                project_client=project_client,
            )

            resources = gateway.ingest([document])

        self.assertEqual(resources.vector_store_id, "vector-store-1")
        self.assertEqual(resources.file_ids, ["file-1"])
        self.assertEqual(resources.agent_name, project_client.agents.agent_name)
        self.assertEqual(resources.agent_version, "7")
        definition = project_client.agents.definition
        self.assertEqual(definition.model, "answer-model")
        self.assertEqual(
            definition.tools[0].vector_store_ids,
            ["vector-store-1"],
        )
        self.assertEqual(definition.tool_choice, "required")

    def test_answer_invokes_exact_persisted_agent_version(self) -> None:
        request_body: JsonObject | None = None

        def handle(request: httpx.Request) -> httpx.Response:
            nonlocal request_body
            if request.method == "POST" and request.url.path.endswith(
                "/conversations"
            ):
                return httpx.Response(
                    200, json={"id": "conversation-1"}, request=request
                )
            if request.method == "GET" and request.url.path.endswith(
                "/conversations/conversation-1/items"
            ):
                return httpx.Response(
                    200,
                    json={
                        "data": (
                            []
                            if request_body is None
                            else [{"id": "assistant-item"}]
                        ),
                        "has_more": False,
                    },
                    request=request,
                )
            if request.method == "POST" and request.url.path.endswith(
                "/responses"
            ):
                request_body = json.loads(request.content)
                return httpx.Response(
                    200,
                    json={
                        "id": "response-1",
                        "status": "completed",
                        "output": [
                            {
                                "type": "file_search_call",
                                "results": [
                                    {"text": "Retrieved reset instructions."}
                                ],
                            },
                            {
                                "type": "message",
                                "content": [
                                    {
                                        "type": "output_text",
                                        "text": "Hold reset for ten seconds.",
                                        "annotations": [
                                            {
                                                "type": "file_citation",
                                                "file_id": "file-1",
                                                "filename": "manual.md",
                                            }
                                        ],
                                    }
                                ],
                            },
                        ],
                    },
                    request=request,
                )
            self.fail(f"Unexpected request: {request.method} {request.url}")

        with httpx.Client(transport=httpx.MockTransport(handle)) as client:
            gateway = FoundryRestGateway(
                "https://example.test/api/projects/support",
                FakeCredential(),
                "answer-model",
                "evaluation-model",
                "https://ai.azure.com/.default",
                client=client,
                project_client=FakeProjectClient(),
            )

            answer = gateway.ask(RESOURCES, None, "How do I reset it?")

        self.assertEqual(answer.response_id, "response-1")
        self.assertIsNotNone(request_body)
        assert request_body is not None
        self.assertEqual(
            request_body["agent_reference"],
            {
                "type": "agent_reference",
                "name": RESOURCES.agent_name,
                "version": RESOURCES.agent_version,
            },
        )
        self.assertNotIn("model", request_body)
        self.assertNotIn("instructions", request_body)
        self.assertNotIn("tools", request_body)

    def test_cleanup_deletes_agent_before_retrieval_resources(self) -> None:
        operations: list[str] = []
        project_client = FakeProjectClient(operations)

        def handle(request: httpx.Request) -> httpx.Response:
            if request.method != "DELETE":
                self.fail(f"Unexpected request: {request.method} {request.url}")
            if request.url.path.endswith("/vector_stores/vector-store-1"):
                operations.append("vector-store")
            elif request.url.path.endswith("/files/file-1"):
                operations.append("file")
            else:
                self.fail(f"Unexpected cleanup request: {request.url}")
            return httpx.Response(204, request=request)

        with httpx.Client(transport=httpx.MockTransport(handle)) as client:
            gateway = FoundryRestGateway(
                "https://example.test/api/projects/support",
                FakeCredential(),
                "answer-model",
                "evaluation-model",
                "https://ai.azure.com/.default",
                client=client,
                project_client=project_client,
            )

            gateway.cleanup(RESOURCES, [])

        self.assertEqual(operations, ["agent", "vector-store", "file"])

    def test_agent_creation_transport_failure_compensates_all_resources(
        self,
    ) -> None:
        operations: list[str] = []
        project_client = FakeProjectClient(operations)
        project_client.agents.create_failure = ServiceRequestError(
            "agent response lost"
        )

        def handle(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path.endswith(
                "/vector_stores"
            ):
                return httpx.Response(
                    200, json={"id": "vector-store-1"}, request=request
                )
            if request.method == "POST" and request.url.path.endswith(
                "/vector_stores/vector-store-1/files"
            ):
                return httpx.Response(
                    200, json={"id": "attached-1"}, request=request
                )
            if request.method == "POST" and request.url.path.endswith("/files"):
                return httpx.Response(
                    200, json={"id": "file-1"}, request=request
                )
            if request.method == "GET" and request.url.path.endswith(
                "/vector_stores/vector-store-1/files/attached-1"
            ):
                return httpx.Response(
                    200, json={"status": "completed"}, request=request
                )
            if request.method == "DELETE" and request.url.path.endswith(
                "/vector_stores/vector-store-1"
            ):
                operations.append("vector-store")
                return httpx.Response(204, request=request)
            if request.method == "DELETE" and request.url.path.endswith(
                "/files/file-1"
            ):
                operations.append("file")
                return httpx.Response(204, request=request)
            self.fail(f"Unexpected request: {request.method} {request.url}")

        with (
            TemporaryDirectory() as directory,
            httpx.Client(transport=httpx.MockTransport(handle)) as client,
        ):
            document = Path(directory, "manual.md")
            document.write_text("Product documentation.", encoding="utf-8")
            gateway = FoundryRestGateway(
                "https://example.test/api/projects/support",
                FakeCredential(),
                "answer-model",
                "evaluation-model",
                "https://ai.azure.com/.default",
                client=client,
                project_client=project_client,
            )

            with self.assertRaises(ServiceRequestError):
                gateway.ingest([document])

        self.assertEqual(operations, ["agent", "vector-store", "file"])

    def test_reads_previous_state_for_cleanup_and_reinitialization(self) -> None:
        state = state_from_dict(
            {
                "version": 1,
                "resources": {
                    "vector_store_id": "legacy-vector-store",
                    "file_ids": ["legacy-file"],
                },
                "conversations": {},
                "answers": [],
                "unresolved_questions": [],
                "feedback": [],
            }
        )

        self.assertEqual(state.version, 2)
        self.assertIsNotNone(state.resources)
        assert state.resources is not None
        self.assertIsNone(state.resources.agent_name)
        self.assertIsNone(state.resources.agent_version)

    def test_isolates_employee_conversations_and_reuses_follow_up(self) -> None:
        gateway = FakeGateway()
        assistant = SupportAssistant(gateway, MemoryStateStore())
        assistant.ingest([Path("manual.md")])

        assistant.ask("employee-a", "shared", "First employee")
        assistant.ask("employee-b", "shared", "Second employee")
        assistant.ask("employee-a", "shared", "Follow-up")

        self.assertEqual(
            gateway.seen_conversation_ids,
            [None, None, "conversation-1"],
        )

    def test_rejects_unknown_and_mismatched_feedback(self) -> None:
        gateway = FakeGateway()
        assistant = SupportAssistant(gateway, MemoryStateStore())
        assistant.ingest([Path("manual.md")])
        answer = assistant.ask("employee-a", "chat-1", "Reset?")

        with self.assertRaises(SupportAssistantError):
            assistant.record_feedback(
                "employee-a", "chat-1", "missing", "negative", None
            )
        with self.assertRaises(SupportAssistantError):
            assistant.record_feedback(
                "employee-b",
                "chat-1",
                answer.response_id,
                "negative",
                None,
            )

    def test_evaluation_uses_retrieved_context(self) -> None:
        gateway = FakeGateway()
        assistant = SupportAssistant(gateway, MemoryStateStore())
        assistant.ingest([Path("manual.md")])

        metrics = assistant.evaluate(
            [EvaluationCase("reset", "How do I reset it?", "Hold reset.")]
        )

        self.assertEqual(metrics[0].name, "groundedness")
        self.assertEqual(
            gateway.evaluation_rows[0]["context"],
            "Retrieved reset instructions.",
        )
        self.assertEqual(gateway.deleted_conversations, ["conversation-1"])

    def test_compensates_when_atomic_state_write_fails(self) -> None:
        gateway = FakeGateway()
        store = MemoryStateStore()
        assistant = SupportAssistant(gateway, store)
        assistant.ingest([Path("manual.md")])
        store.fail_on_save = 2

        with self.assertRaises(OSError):
            assistant.ask("employee-a", "chat-1", "Reset?")

        self.assertEqual(gateway.deleted_conversations, ["conversation-1"])

    def test_http_routes_enforce_identity_and_admin(self) -> None:
        gateway = FakeGateway()
        assistant = SupportAssistant(gateway, MemoryStateStore())
        options = ServerOptions(
            require_authentication=True,
            admin_principal_ids=frozenset({"admin"}),
            materials=(Path("manual.md"),),
            evaluation_dataset=Path("evaluation/support-cases.jsonl"),
        )
        server = create_server(assistant, options)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}"
        try:
            self.assertEqual(
                _request(base_url + "/admin/ingest", "POST", {}, "admin")[0],
                201,
            )
            first = _request(
                base_url + "/conversations/shared/messages",
                "POST",
                {"question": "First"},
                "employee-a",
            )
            _request(
                base_url + "/conversations/shared/messages",
                "POST",
                {"question": "Second"},
                "employee-b",
            )
            _request(
                base_url + "/conversations/shared/messages",
                "POST",
                {"question": "Follow-up"},
                "employee-a",
            )
            self.assertEqual(first[0], 200)
            self.assertEqual(
                gateway.seen_conversation_ids,
                [None, None, "conversation-1"],
            )
            self.assertEqual(
                _request(base_url + "/admin/unresolved", "GET", None, "user")[
                    0
                ],
                403,
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_deletes_new_conversation_when_baseline_transport_fails(self) -> None:
        deleted: list[str] = []

        def handle(request: httpx.Request) -> httpx.Response:
            if request.method == "POST" and request.url.path.endswith(
                "/conversations"
            ):
                return httpx.Response(
                    200, json={"id": "conversation-1"}, request=request
                )
            if request.method == "GET" and request.url.path.endswith(
                "/conversations/conversation-1/items"
            ):
                raise httpx.ConnectError("connection failed", request=request)
            if request.method == "DELETE" and request.url.path.endswith(
                "/conversations/conversation-1"
            ):
                deleted.append("conversation-1")
                return httpx.Response(204, request=request)
            self.fail(f"Unexpected request: {request.method} {request.url}")

        with httpx.Client(transport=httpx.MockTransport(handle)) as client:
            gateway = FoundryRestGateway(
                "https://example.test/api/projects/support",
                FakeCredential(),
                "answer-model",
                "evaluation-model",
                "https://ai.azure.com/.default",
                client=client,
            )
            with self.assertRaises(httpx.RequestError):
                gateway.ask(RESOURCES, None, "Reset?")

        self.assertEqual(deleted, ["conversation-1"])

    def test_background_evaluation_failure_reaches_failed_state(self) -> None:
        gateway = FakeGateway()
        gateway.evaluation_failure = ExceptionGroup(
            "evaluation and cleanup failed",
            [TimeoutError("evaluation timed out"), RuntimeError("cleanup failed")],
        )
        assistant = SupportAssistant(gateway, MemoryStateStore())
        assistant.ingest([Path("manual.md")])
        options = ServerOptions(
            require_authentication=True,
            admin_principal_ids=frozenset({"admin"}),
            materials=(Path("manual.md"),),
            evaluation_dataset=Path("evaluation/support-cases.jsonl"),
        )
        server = create_server(assistant, options)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}"
        try:
            status, body = _request(
                base_url + "/admin/evaluations", "POST", {}, "admin"
            )
            self.assertEqual(status, 202)
            self.assertIsInstance(body, dict)
            operation = _wait_operation(
                base_url, body["operationId"], "admin"
            )
            self.assertIsInstance(operation, dict)
            self.assertEqual(operation["status"], "failed")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_preserves_evaluation_and_cleanup_failures(self) -> None:
        gateway = FakeGateway()
        gateway.evaluation_failure = TimeoutError("evaluation timed out")
        gateway.delete_failure = httpx.ConnectError(
            "cleanup connection failed",
            request=httpx.Request("DELETE", "https://example.test/conversation"),
        )
        assistant = SupportAssistant(gateway, MemoryStateStore())
        assistant.ingest([Path("manual.md")])

        with self.assertRaises(ExceptionGroup) as raised:
            assistant.evaluate(
                [EvaluationCase("reset", "How do I reset it?", "Hold reset.")]
            )

        self.assertEqual(len(raised.exception.exceptions), 2)

    def test_pre_ingestion_evaluation_reaches_failed_state(self) -> None:
        assistant = SupportAssistant(FakeGateway(), MemoryStateStore())
        options = ServerOptions(
            require_authentication=True,
            admin_principal_ids=frozenset({"admin"}),
            materials=(Path("manual.md"),),
            evaluation_dataset=Path("evaluation/support-cases.jsonl"),
        )
        server = create_server(assistant, options)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        base_url = f"http://127.0.0.1:{server.server_port}"
        try:
            status, body = _request(
                base_url + "/admin/evaluations", "POST", {}, "admin"
            )
            self.assertEqual(status, 202)
            self.assertIsInstance(body, dict)
            operation = _wait_operation(
                base_url, body["operationId"], "admin"
            )
            self.assertEqual(operation["status"], "failed")
            self.assertIn("must be ingested", operation["error"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_preserves_blob_request_failure_and_cleanup_auth_failure(self) -> None:
        gateway = FakeGateway()
        gateway.cleanup_failure = ClientAuthenticationError(
            "cleanup authentication failed"
        )
        store = TypedFailingStateStore(
            1, ServiceRequestError("state upload failed")
        )
        assistant = SupportAssistant(gateway, store)

        with self.assertRaises(ExceptionGroup) as raised:
            assistant.ingest([Path("manual.md")])

        self.assertIsInstance(
            raised.exception.exceptions[0], ServiceRequestError
        )
        self.assertIsInstance(
            raised.exception.exceptions[1], ClientAuthenticationError
        )
        self.assertEqual(gateway.cleanup_calls, 1)

    def test_compensates_blob_response_failure_after_answer(self) -> None:
        gateway = FakeGateway()
        store = TypedFailingStateStore(
            2, ServiceResponseError("state response failed")
        )
        assistant = SupportAssistant(gateway, store)
        assistant.ingest([Path("manual.md")])

        with self.assertRaises(ServiceResponseError):
            assistant.ask("employee-a", "chat-1", "Reset?")

        self.assertEqual(gateway.deleted_conversations, ["conversation-1"])

    def test_ingestion_commit_then_throw_does_not_delete_resources(self) -> None:
        gateway = FakeGateway()
        store = CommitThenThrowStateStore(1)
        assistant = SupportAssistant(gateway, store)

        assistant.ingest([Path("manual.md")])

        self.assertEqual(store.load().resources, RESOURCES)
        self.assertEqual(gateway.cleanup_calls, 0)

    def test_new_answer_commit_then_throw_does_not_delete_conversation(
        self,
    ) -> None:
        gateway = FakeGateway()
        store = CommitThenThrowStateStore(2)
        assistant = SupportAssistant(gateway, store)
        assistant.ingest([Path("manual.md")])

        answer = assistant.ask("employee-a", "chat-1", "Reset?")

        self.assertEqual(store.load().answers[0].response_id, answer.response_id)
        self.assertEqual(gateway.deleted_conversations, [])

    def test_follow_up_commit_then_throw_does_not_roll_back_turn(self) -> None:
        gateway = FakeGateway()
        store = CommitThenThrowStateStore(3)
        assistant = SupportAssistant(gateway, store)
        assistant.ingest([Path("manual.md")])
        assistant.ask("employee-a", "chat-1", "Reset?")

        assistant.ask("employee-a", "chat-1", "What happens next?")

        self.assertEqual(len(store.load().answers), 2)
        self.assertEqual(gateway.rolled_back, [])


class FakeGateway:
    def __init__(self) -> None:
        self.seen_conversation_ids: list[str | None] = []
        self.deleted_conversations: list[str] = []
        self.rolled_back: list[tuple[str, list[str]]] = []
        self.evaluation_rows: list[JsonObject] = []
        self.evaluation_failure: Exception | None = None
        self.delete_failure: Exception | None = None
        self.cleanup_failure: Exception | None = None
        self.cleanup_calls = 0
        self.answer_number = 0

    def ingest(self, _document_paths: object) -> FoundryResources:
        return RESOURCES

    def ask(
        self,
        _resources: FoundryResources,
        conversation_id: str | None,
        _question: str,
    ) -> GatewayAnswer:
        self.seen_conversation_ids.append(conversation_id)
        self.answer_number += 1
        return GatewayAnswer(
            conversation_id=conversation_id
            or f"conversation-{self.answer_number}",
            response_id=f"response-{self.answer_number}",
            text="Hold reset for ten seconds.",
            citations=[Citation("file-1", "manual.md")],
            supported=True,
            turn_item_ids=[
                f"user-{self.answer_number}",
                f"assistant-{self.answer_number}",
            ],
            retrieved_context=["Retrieved reset instructions."],
        )

    def delete_conversation(self, conversation_id: str) -> None:
        self.deleted_conversations.append(conversation_id)
        if self.delete_failure is not None:
            raise self.delete_failure

    def rollback_turn(
        self, conversation_id: str, item_ids: list[str]
    ) -> None:
        self.rolled_back.append((conversation_id, item_ids))

    def run_evaluation(
        self, rows: list[JsonObject]
    ) -> list[EvaluationMetric]:
        self.evaluation_rows = rows
        if self.evaluation_failure is not None:
            raise self.evaluation_failure
        return [
            EvaluationMetric(
                "item-1", "completed", "groundedness", 5.0, True
            )
        ]

    def cleanup(
        self,
        _resources: FoundryResources,
        _conversation_ids: list[str],
    ) -> None:
        self.cleanup_calls += 1
        if self.cleanup_failure is not None:
            raise self.cleanup_failure


class FakeAgentsClient:
    def __init__(self, operations: list[str] | None = None) -> None:
        self.operations = operations
        self.agent_name = "contoso-product-support-test"
        self.definition: object | None = None
        self.create_failure: Exception | None = None

    def create_version(
        self,
        *,
        agent_name: str,
        definition: object,
        description: str,
    ) -> object:
        del description
        self.agent_name = agent_name
        self.definition = definition
        if self.create_failure is not None:
            raise self.create_failure
        return SimpleNamespace(name=agent_name, version="7")

    def delete_version(self, *, agent_name: str, agent_version: str) -> None:
        self.agent_name = agent_name
        if agent_version != "1" and agent_version != "7":
            raise AssertionError(f"Unexpected agent version: {agent_version}")
        if self.operations is not None:
            self.operations.append("agent")

    def delete(self, *, agent_name: str, force: bool) -> None:
        if not force:
            raise AssertionError("Ambiguous agent cleanup must be forced.")
        self.agent_name = agent_name
        if self.operations is not None:
            self.operations.append("agent")


class FakeProjectClient:
    def __init__(self, operations: list[str] | None = None) -> None:
        self.agents = FakeAgentsClient(operations)


class TypedFailingStateStore(MemoryStateStore):
    def __init__(self, fail_on_save: int, failure: Exception) -> None:
        super().__init__()
        self._typed_save_count = 0
        self._fail_on_save = fail_on_save
        self._failure = failure

    def save(self, state: AssistantState) -> None:
        self._typed_save_count += 1
        if self._typed_save_count == self._fail_on_save:
            raise self._failure
        super().save(state)


class CommitThenThrowStateStore(MemoryStateStore):
    def __init__(self, fail_on_save: int) -> None:
        super().__init__()
        self._commit_save_count = 0
        self._fail_on_save = fail_on_save

    def save(self, state: AssistantState) -> None:
        super().save(state)
        self._commit_save_count += 1
        if self._commit_save_count == self._fail_on_save:
            raise ServiceResponseError("Blob committed before response failure")


class FakeCredential(TokenCredential):
    def get_token(self, *scopes: str, **kwargs: object) -> AccessToken:
        return AccessToken("test-token", int(time.time()) + 3600)


def _request(
    url: str,
    method: str,
    body: object | None,
    principal_id: str,
) -> tuple[int, object]:
    data = None if body is None else json.dumps(body).encode()
    request = Request(
        url,
        method=method,
        data=data,
        headers={
            "Content-Type": "application/json",
            "X-MS-CLIENT-PRINCIPAL-ID": principal_id,
        },
    )
    try:
        with urlopen(request) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def _wait_operation(
    base_url: str, operation_id: str, principal_id: str
) -> dict[str, object]:
    for _ in range(100):
        _, operation = _request(
            base_url + f"/admin/operations/{operation_id}",
            "GET",
            None,
            principal_id,
        )
        if (
            isinstance(operation, dict)
            and operation.get("status") != "running"
        ):
            return operation
        time.sleep(0.01)
    raise AssertionError("Evaluation operation remained running.")


if __name__ == "__main__":
    unittest.main()
