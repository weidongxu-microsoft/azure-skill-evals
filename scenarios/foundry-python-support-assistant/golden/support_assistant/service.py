from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

import httpx
from azure.core.exceptions import (
    ClientAuthenticationError,
    HttpResponseError,
    ServiceRequestError,
    ServiceResponseError,
)

from .foundry import JsonObject, SupportGateway
from .models import (
    AssistantState,
    EvaluationCase,
    EvaluationMetric,
    FeedbackRecord,
    FoundryResources,
    StoredAnswer,
    SupportAnswer,
    UnresolvedQuestion,
)
from .state import StateStore

DURABLE_STORE_ERRORS = (
    ClientAuthenticationError,
    HttpResponseError,
    httpx.RequestError,
    OSError,
    ServiceRequestError,
    ServiceResponseError,
    TimeoutError,
)
DURABLE_STORE_LOAD_ERRORS = (*DURABLE_STORE_ERRORS, ValueError)


class SupportAssistantError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SupportAssistant:
    def __init__(self, gateway: SupportGateway, store: StateStore) -> None:
        self._gateway = gateway
        self._store = store
        self._lock = RLock()

    def ingest(self, document_paths: Sequence[Path]) -> None:
        with self._lock:
            state = self._store.load()
            if state.resources is not None:
                raise SupportAssistantError(
                    "already_ingested",
                    "Product documentation is already ingested.",
                )
            resources = self._gateway.ingest(document_paths)
            state.resources = resources
            try:
                self._store.save(state)
            except DURABLE_STORE_ERRORS as error:
                if self._ingestion_commit_status(resources, error):
                    return
                try:
                    self._gateway.cleanup(resources, [])
                except (
                    ClientAuthenticationError,
                    ExceptionGroup,
                    HttpResponseError,
                    httpx.RequestError,
                    RuntimeError,
                    ServiceRequestError,
                    ServiceResponseError,
                    TimeoutError,
                ) as cleanup_error:
                    raise ExceptionGroup(
                        "State persistence failed and new Foundry resources "
                        "were not fully deleted.",
                        [error, cleanup_error],
                    ) from error
                raise

    def ask(
        self, employee_id: str, local_conversation_id: str, question: str
    ) -> SupportAnswer:
        with self._lock:
            state = self._store.load()
            if state.resources is None:
                raise SupportAssistantError(
                    "not_ingested",
                    "Product documentation must be ingested before questions.",
                )
            key = _conversation_key(employee_id, local_conversation_id)
            existing_conversation_id = state.conversations.get(key)
            gateway_answer = self._gateway.ask(
                state.resources, existing_conversation_id, question
            )
            answer = SupportAnswer(
                conversation_id=gateway_answer.conversation_id,
                response_id=gateway_answer.response_id,
                text=gateway_answer.text,
                citations=gateway_answer.citations,
                supported=gateway_answer.supported,
            )
            created_at = datetime.now(UTC).isoformat()
            state.conversations[key] = answer.conversation_id
            state.answers.append(
                StoredAnswer(
                    employee_id=employee_id,
                    local_conversation_id=local_conversation_id,
                    question=question,
                    created_at=created_at,
                    conversation_id=answer.conversation_id,
                    response_id=answer.response_id,
                    text=answer.text,
                    citations=answer.citations,
                    supported=answer.supported,
                )
            )
            unresolved: UnresolvedQuestion | None = None
            if not answer.supported:
                unresolved = UnresolvedQuestion(
                    employee_id=employee_id,
                    local_conversation_id=local_conversation_id,
                    question=question,
                    response_id=answer.response_id,
                    created_at=created_at,
                )
                state.unresolved_questions.append(unresolved)
            try:
                self._store.save(state)
            except DURABLE_STORE_ERRORS as error:
                committed = self._answer_commit_status(
                    key,
                    existing_conversation_id,
                    stored_answer=state.answers[-1],
                    unresolved=unresolved,
                    error=error,
                )
                if committed:
                    return answer
                try:
                    if existing_conversation_id is None:
                        self._gateway.delete_conversation(answer.conversation_id)
                    else:
                        self._gateway.rollback_turn(
                            answer.conversation_id,
                            gateway_answer.turn_item_ids,
                        )
                except (
                    ExceptionGroup,
                    ClientAuthenticationError,
                    HttpResponseError,
                    httpx.RequestError,
                    RuntimeError,
                    ServiceRequestError,
                    ServiceResponseError,
                    TimeoutError,
                ) as cleanup_error:
                    raise ExceptionGroup(
                        "State persistence failed and the Foundry turn "
                        "was not compensated.",
                        [error, cleanup_error],
                    ) from error
                raise
            return answer

    def record_feedback(
        self,
        employee_id: str,
        local_conversation_id: str,
        response_id: str,
        rating: str,
        comment: str | None,
    ) -> None:
        if rating not in {"positive", "negative"}:
            raise ValueError("rating must be positive or negative.")
        with self._lock:
            state = self._store.load()
            answer = next(
                (
                    item
                    for item in state.answers
                    if item.response_id == response_id
                    and item.employee_id == employee_id
                    and item.local_conversation_id == local_conversation_id
                ),
                None,
            )
            if answer is None:
                raise SupportAssistantError(
                    "response_not_found",
                    "The response is unknown or belongs to another employee "
                    "or conversation.",
                )
            state.feedback.append(
                FeedbackRecord(
                    employee_id=employee_id,
                    local_conversation_id=local_conversation_id,
                    response_id=response_id,
                    rating=rating,
                    comment=comment,
                    created_at=datetime.now(UTC).isoformat(),
                )
            )
            self._store.save(state)

    def evaluate(
        self, cases: Sequence[EvaluationCase]
    ) -> list[EvaluationMetric]:
        with self._lock:
            state = self._store.load()
            if state.resources is None:
                raise SupportAssistantError(
                    "not_ingested",
                    "Product documentation must be ingested before evaluation.",
                )
            rows: list[JsonObject] = []
            conversations: list[str] = []
            evaluation_error: Exception | None = None
            metrics: list[EvaluationMetric] = []
            try:
                for case in cases:
                    answer = self._gateway.ask(
                        state.resources, None, case.query
                    )
                    conversations.append(answer.conversation_id)
                    if not answer.retrieved_context:
                        raise RuntimeError(
                            f"Evaluation case {case.case_id} returned no "
                            "retrieved context."
                        )
                    rows.append(
                        {
                            "query": case.query,
                            "response": answer.text,
                            "context": "\n\n".join(answer.retrieved_context),
                            "ground_truth": case.ground_truth,
                        }
                    )
                metrics = self._gateway.run_evaluation(rows)
            except (
                ClientAuthenticationError,
                ExceptionGroup,
                HttpResponseError,
                httpx.RequestError,
                RuntimeError,
                TimeoutError,
                ValueError,
            ) as error:
                evaluation_error = error
            cleanup_errors: list[Exception] = []
            for conversation_id in conversations:
                try:
                    self._gateway.delete_conversation(conversation_id)
                except (
                    ExceptionGroup,
                    ClientAuthenticationError,
                    HttpResponseError,
                    httpx.RequestError,
                    RuntimeError,
                    TimeoutError,
                ) as error:
                    cleanup_errors.append(error)
            if evaluation_error and cleanup_errors:
                raise ExceptionGroup(
                    "Evaluation and temporary conversation cleanup failed.",
                    [evaluation_error, *cleanup_errors],
                )
            if evaluation_error:
                raise evaluation_error
            if cleanup_errors:
                raise ExceptionGroup(
                    "Temporary evaluation conversations were not deleted.",
                    cleanup_errors,
                )
            return metrics

    def cleanup(self) -> None:
        with self._lock:
            state = self._store.load()
            if state.resources is None:
                return
            self._gateway.cleanup(
                state.resources, list(state.conversations.values())
            )
            state.resources = None
            state.conversations.clear()
            self._store.save(state)

    def unresolved_questions(self) -> list[UnresolvedQuestion]:
        with self._lock:
            return list(self._store.load().unresolved_questions)

    def _ingestion_commit_status(
        self,
        resources: FoundryResources,
        error: Exception,
    ) -> bool:
        identifiers = (
            f"vectorStoreId={resources.vector_store_id} "
            f"fileIds={','.join(resources.file_ids)} "
            f"agentName={resources.agent_name or '<none>'} "
            f"agentVersion={resources.agent_version or '<none>'}"
        )
        reloaded = self._reload_after_failed_save(
            f"Could not verify ingestion state for {identifiers}.",
            error,
        )
        if reloaded.resources == resources:
            return True
        if reloaded.resources is None:
            return False
        raise ExceptionGroup(
            f"Ingestion state is ambiguous for {identifiers}; "
            "no Foundry resources were deleted.",
            [
                error,
                RuntimeError(
                    "Durable state contains different resource ownership: "
                    f"vectorStoreId={reloaded.resources.vector_store_id} "
                    f"agentName={reloaded.resources.agent_name or '<none>'} "
                    "agentVersion="
                    f"{reloaded.resources.agent_version or '<none>'}."
                ),
            ],
        )

    def _answer_commit_status(
        self,
        key: str,
        existing_conversation_id: str | None,
        stored_answer: StoredAnswer,
        unresolved: UnresolvedQuestion | None,
        error: Exception,
    ) -> bool:
        identifiers = (
            f"conversationId={stored_answer.conversation_id} "
            f"responseId={stored_answer.response_id}"
        )
        reloaded = self._reload_after_failed_save(
            f"Could not verify answer state for {identifiers}.",
            error,
        )
        mapping_matches = (
            reloaded.conversations.get(key) == stored_answer.conversation_id
        )
        answer_present = stored_answer in reloaded.answers
        unresolved_present = (
            unresolved is None
            or unresolved in reloaded.unresolved_questions
        )
        if mapping_matches and answer_present and unresolved_present:
            return True

        mapping_unchanged = (
            key not in reloaded.conversations
            if existing_conversation_id is None
            else reloaded.conversations.get(key)
            == existing_conversation_id
        )
        response_absent = not any(
            item.response_id == stored_answer.response_id
            for item in reloaded.answers
        )
        unresolved_absent = not any(
            item.response_id == stored_answer.response_id
            for item in reloaded.unresolved_questions
        )
        if mapping_unchanged and response_absent and unresolved_absent:
            return False

        raise ExceptionGroup(
            f"Answer state is ambiguous for {identifiers}; "
            "the Foundry conversation was not deleted or rolled back.",
            [
                error,
                RuntimeError(
                    "Durable state contains only part of the intended "
                    "answer/conversation mutation."
                ),
            ],
        )

    def _reload_after_failed_save(
        self,
        message: str,
        error: Exception,
    ) -> AssistantState:
        try:
            return self._store.load()
        except DURABLE_STORE_LOAD_ERRORS as reload_error:
            raise ExceptionGroup(
                f"{message} No destructive compensation was attempted.",
                [error, reload_error],
            ) from error


def _conversation_key(employee_id: str, conversation_id: str) -> str:
    return f"{employee_id}:{conversation_id}"
