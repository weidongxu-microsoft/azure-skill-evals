from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class Citation:
    file_id: str
    filename: str


@dataclass(frozen=True, slots=True)
class FoundryResources:
    vector_store_id: str
    file_ids: list[str]


@dataclass(frozen=True, slots=True)
class SupportAnswer:
    conversation_id: str
    response_id: str
    text: str
    citations: list[Citation]
    supported: bool


@dataclass(frozen=True, slots=True)
class GatewayAnswer(SupportAnswer):
    turn_item_ids: list[str]
    retrieved_context: list[str]


@dataclass(frozen=True, slots=True)
class StoredAnswer(SupportAnswer):
    employee_id: str
    local_conversation_id: str
    question: str
    created_at: str


@dataclass(frozen=True, slots=True)
class UnresolvedQuestion:
    employee_id: str
    local_conversation_id: str
    question: str
    response_id: str
    created_at: str


@dataclass(frozen=True, slots=True)
class FeedbackRecord:
    employee_id: str
    local_conversation_id: str
    response_id: str
    rating: str
    created_at: str
    comment: str | None = None


@dataclass(frozen=True, slots=True)
class EvaluationCase:
    case_id: str
    query: str
    ground_truth: str


@dataclass(frozen=True, slots=True)
class EvaluationMetric:
    item_id: str
    item_status: str
    name: str
    score: float | None
    passed: bool | None


@dataclass(slots=True)
class AssistantState:
    version: int = 1
    resources: FoundryResources | None = None
    conversations: dict[str, str] = field(default_factory=dict)
    answers: list[StoredAnswer] = field(default_factory=list)
    unresolved_questions: list[UnresolvedQuestion] = field(default_factory=list)
    feedback: list[FeedbackRecord] = field(default_factory=list)
    etag: str | None = field(default=None, repr=False, compare=False)
    loaded: bool = field(default=False, repr=False, compare=False)


def state_to_dict(state: AssistantState) -> dict[str, Any]:
    value = asdict(state)
    value.pop("etag")
    value.pop("loaded")
    return value


def state_from_dict(value: object) -> AssistantState:
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("State has an unsupported shape.")
    conversations = value.get("conversations")
    answers = value.get("answers")
    unresolved = value.get("unresolved_questions")
    feedback = value.get("feedback")
    if not isinstance(conversations, dict):
        raise ValueError("State conversations must be an object.")
    if not all(isinstance(item, list) for item in (answers, unresolved, feedback)):
        raise ValueError("State record collections must be arrays.")
    resources_value = value.get("resources")
    resources = (
        None
        if resources_value is None
        else FoundryResources(
            vector_store_id=_required_string(resources_value, "vector_store_id"),
            file_ids=_string_list(resources_value, "file_ids"),
        )
    )
    return AssistantState(
        resources=resources,
        conversations={
            str(key): str(item) for key, item in conversations.items()
        },
        answers=[_stored_answer(item) for item in answers],
        unresolved_questions=[_unresolved(item) for item in unresolved],
        feedback=[_feedback(item) for item in feedback],
        loaded=True,
    )


def _stored_answer(value: object) -> StoredAnswer:
    return StoredAnswer(
        conversation_id=_required_string(value, "conversation_id"),
        response_id=_required_string(value, "response_id"),
        text=_required_string(value, "text"),
        citations=[
            Citation(
                file_id=_required_string(item, "file_id"),
                filename=_required_string(item, "filename"),
            )
            for item in _object_list(value, "citations")
        ],
        supported=_required_bool(value, "supported"),
        employee_id=_required_string(value, "employee_id"),
        local_conversation_id=_required_string(value, "local_conversation_id"),
        question=_required_string(value, "question"),
        created_at=_required_string(value, "created_at"),
    )


def _unresolved(value: object) -> UnresolvedQuestion:
    return UnresolvedQuestion(
        employee_id=_required_string(value, "employee_id"),
        local_conversation_id=_required_string(value, "local_conversation_id"),
        question=_required_string(value, "question"),
        response_id=_required_string(value, "response_id"),
        created_at=_required_string(value, "created_at"),
    )


def _feedback(value: object) -> FeedbackRecord:
    comment = _optional_string(value, "comment")
    return FeedbackRecord(
        employee_id=_required_string(value, "employee_id"),
        local_conversation_id=_required_string(value, "local_conversation_id"),
        response_id=_required_string(value, "response_id"),
        rating=_required_string(value, "rating"),
        created_at=_required_string(value, "created_at"),
        comment=comment,
    )


def _required_string(value: object, key: str) -> str:
    if not isinstance(value, dict) or not isinstance(value.get(key), str):
        raise ValueError(f"State property {key} must be a string.")
    return value[key]


def _optional_string(value: object, key: str) -> str | None:
    if not isinstance(value, dict):
        raise ValueError("State record must be an object.")
    item = value.get(key)
    if item is not None and not isinstance(item, str):
        raise ValueError(f"State property {key} must be a string.")
    return item


def _required_bool(value: object, key: str) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get(key), bool):
        raise ValueError(f"State property {key} must be a boolean.")
    return value[key]


def _object_list(value: object, key: str) -> list[object]:
    if not isinstance(value, dict) or not isinstance(value.get(key), list):
        raise ValueError(f"State property {key} must be an array.")
    return value[key]


def _string_list(value: object, key: str) -> list[str]:
    items = _object_list(value, key)
    if not all(isinstance(item, str) for item in items):
        raise ValueError(f"State property {key} must contain strings.")
    return items
