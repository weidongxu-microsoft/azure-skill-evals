from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any


@dataclass
class TodoItem:
    id: str
    title: str
    description: str
    completed: bool
    created_at: str
    category: str
    etag: str | None = None

    @classmethod
    def new(
        cls,
        item_id: str,
        title: str,
        description: str,
        category: str,
    ) -> TodoItem:
        return cls(
            id=item_id,
            title=title,
            description=description,
            completed=False,
            created_at=datetime.now(UTC).isoformat(),
            category=category,
        )

    @classmethod
    def from_document(cls, document: dict[str, Any]) -> TodoItem:
        return cls(
            id=document["id"],
            title=document["title"],
            description=document["description"],
            completed=document["completed"],
            created_at=document["created_at"],
            category=document["category"],
            etag=document.get("_etag"),
        )

    def to_document(self) -> dict[str, Any]:
        document = asdict(self)
        document.pop("etag")
        return document
