from __future__ import annotations

import logging

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.servicebus import NEXT_AVAILABLE_SESSION, ServiceBusClient
from azure.servicebus.aio import ServiceBusClient as AsyncServiceBusClient
from azure.servicebus.exceptions import ServiceBusError

from config import ServiceBusConfig
from order import Order, message_body_as_bytes
from service_bus_common import (
    dead_letter_description,
    is_transient_service_bus_error,
    log_service_bus_error,
    process_order,
)

logger = logging.getLogger(__name__)


class OrderProcessor:
    def __init__(self, config: ServiceBusConfig) -> None:
        self._config = config

    def process(self, max_messages: int = 100, wait_seconds: int = 5) -> int:
        try:
            return self._process(max_messages, wait_seconds)
        except ServiceBusError as exc:
            log_service_bus_error(exc, self._config.queue_name, "receive or settle")
            raise

    def _process(self, max_messages: int, wait_seconds: int) -> int:
        processed = 0
        with DefaultAzureCredential() as credential:
            with ServiceBusClient(
                self._config.fully_qualified_namespace, credential
            ) as client:
                with client.get_queue_receiver(
                    queue_name=self._config.queue_name,
                    session_id=NEXT_AVAILABLE_SESSION,
                    max_wait_time=wait_seconds,
                ) as receiver:
                    messages = receiver.receive_messages(
                        max_message_count=max_messages,
                        max_wait_time=wait_seconds,
                    )
                    for message in messages:
                        try:
                            order = Order.from_json(message_body_as_bytes(message))
                        except ValueError as exc:
                            logger.error(
                                "Dead-lettering invalid order; entity=%s detail=%s",
                                self._config.queue_name,
                                exc,
                            )
                            receiver.dead_letter_message(
                                message,
                                reason="OrderDeserializationFailed",
                                error_description=dead_letter_description(exc),
                            )
                            continue
                        try:
                            process_order(order)
                        except ServiceBusError as exc:
                            log_service_bus_error(
                                exc, self._config.queue_name, "process"
                            )
                            if is_transient_service_bus_error(exc):
                                receiver.abandon_message(message)
                            else:
                                receiver.dead_letter_message(
                                    message,
                                    reason="NonTransientProcessingFailure",
                                    error_description=dead_letter_description(exc),
                                )
                        except Exception as exc:
                            logger.exception(
                                "Non-transient order processing failure; entity=%s",
                                self._config.queue_name,
                            )
                            receiver.dead_letter_message(
                                message,
                                reason="NonTransientProcessingFailure",
                                error_description=dead_letter_description(exc),
                            )
                        else:
                            receiver.complete_message(message)
                            processed += 1
        return processed


class AsyncOrderProcessor:
    def __init__(self, config: ServiceBusConfig) -> None:
        self._config = config

    async def process(self, max_messages: int = 100, wait_seconds: int = 5) -> int:
        try:
            return await self._process(max_messages, wait_seconds)
        except ServiceBusError as exc:
            log_service_bus_error(
                exc, self._config.queue_name, "async receive or settle"
            )
            raise

    async def _process(self, max_messages: int, wait_seconds: int) -> int:
        processed = 0
        async with AsyncDefaultAzureCredential() as credential:
            async with AsyncServiceBusClient(
                self._config.fully_qualified_namespace, credential
            ) as client:
                async with client.get_queue_receiver(
                    queue_name=self._config.queue_name,
                    session_id=NEXT_AVAILABLE_SESSION,
                    max_wait_time=wait_seconds,
                ) as receiver:
                    messages = await receiver.receive_messages(
                        max_message_count=max_messages,
                        max_wait_time=wait_seconds,
                    )
                    for message in messages:
                        try:
                            order = Order.from_json(message_body_as_bytes(message))
                        except ValueError as exc:
                            logger.error(
                                "Dead-lettering invalid order; entity=%s detail=%s",
                                self._config.queue_name,
                                exc,
                            )
                            await receiver.dead_letter_message(
                                message,
                                reason="OrderDeserializationFailed",
                                error_description=dead_letter_description(exc),
                            )
                            continue
                        try:
                            process_order(order)
                        except ServiceBusError as exc:
                            log_service_bus_error(
                                exc, self._config.queue_name, "async process"
                            )
                            if is_transient_service_bus_error(exc):
                                await receiver.abandon_message(message)
                            else:
                                await receiver.dead_letter_message(
                                    message,
                                    reason="NonTransientProcessingFailure",
                                    error_description=dead_letter_description(exc),
                                )
                        except Exception as exc:
                            logger.exception(
                                "Non-transient async processing failure; entity=%s",
                                self._config.queue_name,
                            )
                            await receiver.dead_letter_message(
                                message,
                                reason="NonTransientProcessingFailure",
                                error_description=dead_letter_description(exc),
                            )
                        else:
                            await receiver.complete_message(message)
                            processed += 1
        return processed
