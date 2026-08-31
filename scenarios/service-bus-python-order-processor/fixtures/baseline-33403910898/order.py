from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any


class OrderStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class Order:
    order_id: str
    customer_name: str
    product: str
    quantity: int
    total_price: Decimal
    status: OrderStatus = OrderStatus.PENDING

    def __post_init__(self) -> None:
        if not self.order_id.strip():
            raise ValueError("order_id must not be empty")
        if not self.customer_name.strip():
            raise ValueError("customer_name must not be empty")
        if not self.product.strip():
            raise ValueError("product must not be empty")
        if isinstance(self.quantity, bool) or self.quantity <= 0:
            raise ValueError("quantity must be a positive integer")
        if self.total_price < 0:
            raise ValueError("total_price must not be negative")

    def to_json(self) -> str:
        payload = asdict(self)
        payload["total_price"] = str(self.total_price)
        payload["status"] = self.status.value
        return json.dumps(payload, separators=(",", ":"))

    @classmethod
    def from_json(cls, value: str | bytes) -> "Order":
        try:
            payload: Any = json.loads(value)
            if not isinstance(payload, dict):
                raise ValueError("order payload must be a JSON object")
            quantity = payload["quantity"]
            if isinstance(quantity, bool) or not isinstance(quantity, int):
                raise ValueError("quantity must be an integer")
            return cls(
                order_id=str(payload["order_id"]),
                customer_name=str(payload["customer_name"]),
                product=str(payload["product"]),
                quantity=quantity,
                total_price=Decimal(str(payload["total_price"])),
                status=OrderStatus(payload["status"]),
            )
        except (KeyError, TypeError, InvalidOperation, json.JSONDecodeError) as exc:
            raise ValueError(f"invalid order payload: {exc}") from exc


def message_body_as_bytes(message: Any) -> bytes:
    return b"".join(bytes(section) for section in message.body)
