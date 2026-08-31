from __future__ import annotations

import logging

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.servicebus import (
    NEXT_AVAILABLE_SESSION,
    ServiceBusClient,
    ServiceBusSubQueue,
)
from azure.servicebus.aio import ServiceBusClient as AsyncServiceBusClient
from azure.servicebus.exceptions import ServiceBusError

from config import ServiceBusConfig
from order import Order, message_body_as_bytes
from senders import AsyncOrderSender, OrderSender
from service_bus_common import log_service_bus_error

logger = logging.getLogger(__name__)


class DeadLetterReprocessor:
    def __init__(self, config: ServiceBusConfig, sender: OrderSender) -> None:
        self._config = config
        self._sender = sender

    def reprocess(self, max_messages: int = 100, wait_seconds: int = 5) -> int:
        try:
            return self._reprocess(max_messages, wait_seconds)
        except ServiceBusError as exc:
            log_service_bus_error(
                exc, self._config.queue_name, "dead-letter receive or settle"
            )
            raise

    def _reprocess(self, max_messages: int, wait_seconds: int) -> int:
        republished = 0
        with DefaultAzureCredential() as credential:
            with ServiceBusClient(
                self._config.fully_qualified_namespace, credential
            ) as client:
                with client.get_queue_receiver(
                    queue_name=self._config.queue_name,
                    sub_queue=ServiceBusSubQueue.DEAD_LETTER,
                    session_id=NEXT_AVAILABLE_SESSION,
                    max_wait_time=wait_seconds,
                ) as receiver:
                    messages = receiver.receive_messages(
                        max_message_count=max_messages,
                        max_wait_time=wait_seconds,
                    )
                    for message in messages:
                        logger.info(
                            "Inspecting dead-letter order; entity=%s reason=%s "
                            "description=%s",
                            self._config.queue_name,
                            message.dead_letter_reason,
                            message.dead_letter_error_description,
                        )
                        try:
                            order = Order.from_json(message_body_as_bytes(message))
                        except ValueError as exc:
                            logger.error(
                                "Leaving invalid order in dead-letter subqueue; "
                                "entity=%s detail=%s",
                                self._config.queue_name,
                                exc,
                            )
                            receiver.abandon_message(message)
                            continue
                        try:
                            self._sender.send_order(order)
                            receiver.complete_message(message)
                            republished += 1
                        except ServiceBusError as exc:
                            log_service_bus_error(
                                exc, self._config.queue_name, "dead-letter republish"
                            )
                            receiver.abandon_message(message)
        return republished


class AsyncDeadLetterReprocessor:
    def __init__(
        self, config: ServiceBusConfig, sender: AsyncOrderSender
    ) -> None:
        self._config = config
        self._sender = sender

    async def reprocess(
        self, max_messages: int = 100, wait_seconds: int = 5
    ) -> int:
        try:
            return await self._reprocess(max_messages, wait_seconds)
        except ServiceBusError as exc:
            log_service_bus_error(
                exc,
                self._config.queue_name,
                "async dead-letter receive or settle",
            )
            raise

    async def _reprocess(self, max_messages: int, wait_seconds: int) -> int:
        republished = 0
        async with AsyncDefaultAzureCredential() as credential:
            async with AsyncServiceBusClient(
                self._config.fully_qualified_namespace, credential
            ) as client:
                async with client.get_queue_receiver(
                    queue_name=self._config.queue_name,
                    sub_queue=ServiceBusSubQueue.DEAD_LETTER,
                    session_id=NEXT_AVAILABLE_SESSION,
                    max_wait_time=wait_seconds,
                ) as receiver:
                    messages = await receiver.receive_messages(
                        max_message_count=max_messages,
                        max_wait_time=wait_seconds,
                    )
                    for message in messages:
                        logger.info(
                            "Inspecting dead-letter order; entity=%s reason=%s "
                            "description=%s",
                            self._config.queue_name,
                            message.dead_letter_reason,
                            message.dead_letter_error_description,
                        )
                        try:
                            order = Order.from_json(message_body_as_bytes(message))
                        except ValueError as exc:
                            logger.error(
                                "Leaving invalid order in dead-letter subqueue; "
                                "entity=%s detail=%s",
                                self._config.queue_name,
                                exc,
                            )
                            await receiver.abandon_message(message)
                            continue
                        try:
                            await self._sender.send_order(order)
                            await receiver.complete_message(message)
                            republished += 1
                        except ServiceBusError as exc:
                            log_service_bus_error(
                                exc,
                                self._config.queue_name,
                                "async dead-letter republish",
                            )
                            await receiver.abandon_message(message)
        return republished
