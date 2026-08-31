from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from azure.servicebus import ServiceBusMessage
from azure.servicebus.exceptions import (
    ServiceBusCommunicationError,
    ServiceBusConnectionError,
    ServiceBusError,
)

from order import Order, OrderStatus

HIGH_PRIORITY_PRICE_THRESHOLD = Decimal("1000.00")
HIGH_PRIORITY_DELAY_SECONDS = 30

logger = logging.getLogger(__name__)


def create_order_message(order: Order) -> ServiceBusMessage:
    high_priority = order.total_price > HIGH_PRIORITY_PRICE_THRESHOLD
    scheduled_time = (
        datetime.now(timezone.utc) + timedelta(seconds=HIGH_PRIORITY_DELAY_SECONDS)
        if high_priority
        else None
    )
    return ServiceBusMessage(
        order.to_json(),
        content_type="application/json",
        correlation_id=order.order_id,
        session_id=order.customer_name,
        application_properties={"priority": "high" if high_priority else "normal"},
        scheduled_enqueue_time_utc=scheduled_time,
    )


def is_transient_service_bus_error(exc: ServiceBusError) -> bool:
    return bool(
        getattr(exc, "is_transient", False)
        or isinstance(exc, (ServiceBusCommunicationError, ServiceBusConnectionError))
    )


def log_service_bus_error(
    exc: ServiceBusError, entity_name: str, operation: str
) -> None:
    logger.error(
        "Service Bus %s failed; entity=%s transient=%s type=%s detail=%s",
        operation,
        entity_name,
        is_transient_service_bus_error(exc),
        type(exc).__name__,
        exc,
    )


def dead_letter_description(exc: Exception) -> str:
    description = f"{type(exc).__name__}: {exc}"
    return description[:4096]


def process_order(order: Order) -> None:
    order.status = OrderStatus.PROCESSING
    logger.info(
        "Processing order %s for %s: %s x %d",
        order.order_id,
        order.customer_name,
        order.product,
        order.quantity,
    )
    order.status = OrderStatus.COMPLETED
