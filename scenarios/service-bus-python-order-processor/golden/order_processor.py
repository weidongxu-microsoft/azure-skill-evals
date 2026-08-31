from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import ClassVar

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.servicebus import (
    NEXT_AVAILABLE_SESSION,
    ServiceBusClient,
    ServiceBusMessage,
    ServiceBusSubQueue,
)
from azure.servicebus.aio import ServiceBusClient as AsyncServiceBusClient
from azure.servicebus.exceptions import MessageSizeExceededError, ServiceBusError


LOGGER = logging.getLogger(__name__)
HIGH_VALUE_THRESHOLD = 1_000.0


@dataclass
class Order:
    order_id: str
    customer_name: str
    product: str
    quantity: int
    total_price: float
    status: str = "pending"

    VALID_STATUSES: ClassVar[set[str]] = {
        "pending",
        "processing",
        "completed",
        "failed",
    }

    def to_json(self) -> str:
        if self.status not in self.VALID_STATUSES:
            raise ValueError(f"Unsupported order status: {self.status}")
        return json.dumps(asdict(self))

    @classmethod
    def from_json(cls, value: str) -> Order:
        data = json.loads(value)
        order = cls(**data)
        if order.status not in cls.VALID_STATUSES:
            raise ValueError(f"Unsupported order status: {order.status}")
        return order


def message_for(order: Order) -> ServiceBusMessage:
    properties = {"priority": "normal"}
    arguments: dict[str, object] = {
        "correlation_id": order.order_id,
        "session_id": order.customer_name,
        "application_properties": properties,
    }
    if order.total_price > HIGH_VALUE_THRESHOLD:
        properties["priority"] = "high"
        arguments["scheduled_enqueue_time_utc"] = datetime.now(UTC) + timedelta(
            seconds=30
        )
    return ServiceBusMessage(order.to_json(), **arguments)


def log_service_bus_error(entity_name: str, error: ServiceBusError) -> None:
    category = "transient" if error.is_transient else "non-transient"
    LOGGER.error(
        "Service Bus %s error on entity %s: %s",
        category,
        entity_name,
        error,
    )


class SyncOrderSender:
    def __init__(self, client: ServiceBusClient, queue_name: str) -> None:
        self.client = client
        self.queue_name = queue_name

    def send_order(self, order: Order) -> None:
        with self.client.get_queue_sender(queue_name=self.queue_name) as sender:
            sender.send_messages(message_for(order))

    def send_orders(self, orders: list[Order]) -> None:
        with self.client.get_queue_sender(queue_name=self.queue_name) as sender:
            batch = sender.create_message_batch()
            for order in orders:
                message = message_for(order)
                try:
                    batch.add_message(message)
                except MessageSizeExceededError:
                    if len(batch) == 0:
                        raise
                    sender.send_messages(batch)
                    batch = sender.create_message_batch()
                    batch.add_message(message)
            if len(batch) > 0:
                sender.send_messages(batch)


class AsyncOrderSender:
    def __init__(self, client: AsyncServiceBusClient, queue_name: str) -> None:
        self.client = client
        self.queue_name = queue_name

    async def send_order(self, order: Order) -> None:
        async with self.client.get_queue_sender(queue_name=self.queue_name) as sender:
            await sender.send_messages(message_for(order))

    async def send_orders(self, orders: list[Order]) -> None:
        async with self.client.get_queue_sender(queue_name=self.queue_name) as sender:
            batch = await sender.create_message_batch()
            for order in orders:
                message = message_for(order)
                try:
                    batch.add_message(message)
                except MessageSizeExceededError:
                    if len(batch) == 0:
                        raise
                    await sender.send_messages(batch)
                    batch = await sender.create_message_batch()
                    batch.add_message(message)
            if len(batch) > 0:
                await sender.send_messages(batch)


def process_order(order: Order) -> None:
    order.status = "processing"
    LOGGER.info(
        "Processing order %s for %s: %s x%d",
        order.order_id,
        order.customer_name,
        order.product,
        order.quantity,
    )
    order.status = "completed"


class SyncOrderProcessor:
    def __init__(self, client: ServiceBusClient, queue_name: str) -> None:
        self.client = client
        self.queue_name = queue_name

    def process_orders(self) -> None:
        with self.client.get_queue_receiver(
            queue_name=self.queue_name,
            session_id=NEXT_AVAILABLE_SESSION,
            max_wait_time=5,
        ) as receiver:
            for message in receiver.receive_messages(
                max_message_count=10,
                max_wait_time=5,
            ):
                try:
                    order = Order.from_json(str(message))
                    process_order(order)
                    receiver.complete_message(message)
                except (json.JSONDecodeError, TypeError, ValueError) as error:
                    receiver.dead_letter_message(
                        message,
                        reason="Order deserialization failed",
                        error_description=str(error),
                    )
                except ServiceBusError as error:
                    log_service_bus_error(self.queue_name, error)
                    if error.is_transient:
                        receiver.abandon_message(message)
                    else:
                        receiver.dead_letter_message(
                            message,
                            reason="Non-transient order processing failure",
                            error_description=str(error),
                        )

    def reprocess_dead_letters(self, sender: SyncOrderSender) -> None:
        with self.client.get_queue_receiver(
            queue_name=self.queue_name,
            session_id=NEXT_AVAILABLE_SESSION,
            sub_queue=ServiceBusSubQueue.DEAD_LETTER,
            max_wait_time=5,
        ) as receiver:
            for message in receiver.receive_messages(
                max_message_count=10,
                max_wait_time=5,
            ):
                try:
                    order = Order.from_json(str(message))
                    LOGGER.info("Reprocessing dead-lettered order %s", order.order_id)
                    sender.send_order(order)
                    receiver.complete_message(message)
                except ServiceBusError as error:
                    log_service_bus_error(self.queue_name, error)
                    receiver.abandon_message(message)
                except (json.JSONDecodeError, TypeError, ValueError) as error:
                    LOGGER.error("Cannot reprocess dead-letter message: %s", error)
                    receiver.abandon_message(message)


class AsyncOrderProcessor:
    def __init__(self, client: AsyncServiceBusClient, queue_name: str) -> None:
        self.client = client
        self.queue_name = queue_name

    async def process_orders(self) -> None:
        async with self.client.get_queue_receiver(
            queue_name=self.queue_name,
            session_id=NEXT_AVAILABLE_SESSION,
            max_wait_time=5,
        ) as receiver:
            for message in await receiver.receive_messages(
                max_message_count=10,
                max_wait_time=5,
            ):
                try:
                    order = Order.from_json(str(message))
                    process_order(order)
                    await receiver.complete_message(message)
                except (json.JSONDecodeError, TypeError, ValueError) as error:
                    await receiver.dead_letter_message(
                        message,
                        reason="Order deserialization failed",
                        error_description=str(error),
                    )
                except ServiceBusError as error:
                    log_service_bus_error(self.queue_name, error)
                    if error.is_transient:
                        await receiver.abandon_message(message)
                    else:
                        await receiver.dead_letter_message(
                            message,
                            reason="Non-transient order processing failure",
                            error_description=str(error),
                        )

    async def reprocess_dead_letters(self, sender: AsyncOrderSender) -> None:
        async with self.client.get_queue_receiver(
            queue_name=self.queue_name,
            session_id=NEXT_AVAILABLE_SESSION,
            sub_queue=ServiceBusSubQueue.DEAD_LETTER,
            max_wait_time=5,
        ) as receiver:
            for message in await receiver.receive_messages(
                max_message_count=10,
                max_wait_time=5,
            ):
                try:
                    order = Order.from_json(str(message))
                    LOGGER.info("Reprocessing dead-lettered order %s", order.order_id)
                    await sender.send_order(order)
                    await receiver.complete_message(message)
                except ServiceBusError as error:
                    log_service_bus_error(self.queue_name, error)
                    await receiver.abandon_message(message)
                except (json.JSONDecodeError, TypeError, ValueError) as error:
                    LOGGER.error("Cannot reprocess dead-letter message: %s", error)
                    await receiver.abandon_message(message)


def sample_orders() -> list[Order]:
    return [
        Order("order-100", "Contoso", "keyboard", 2, 180.0),
        Order("order-101", "Fabrikam", "server", 1, 4_500.0),
    ]


async def run_async(
    fully_qualified_namespace: str,
    queue_name: str,
    orders: list[Order],
) -> None:
    async with AsyncDefaultAzureCredential() as credential:
        async with AsyncServiceBusClient(
            fully_qualified_namespace,
            credential,
        ) as client:
            sender = AsyncOrderSender(client, queue_name)
            processor = AsyncOrderProcessor(client, queue_name)
            await sender.send_order(orders[0])
            await sender.send_orders(orders[1:])
            await processor.process_orders()
            await processor.reprocess_dead_letters(sender)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    fully_qualified_namespace = os.environ[
        "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE"
    ]
    queue_name = os.environ["SERVICE_BUS_QUEUE_NAME"]
    orders = sample_orders()

    with DefaultAzureCredential() as credential:
        with ServiceBusClient(
            fully_qualified_namespace,
            credential,
        ) as client:
            sender = SyncOrderSender(client, queue_name)
            processor = SyncOrderProcessor(client, queue_name)
            sender.send_order(orders[0])
            sender.send_orders(orders[1:])
            processor.process_orders()
            processor.reprocess_dead_letters(sender)

    asyncio.run(run_async(fully_qualified_namespace, queue_name, orders))


if __name__ == "__main__":
    main()
