from __future__ import annotations

from collections.abc import Iterable

from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.servicebus import ServiceBusClient
from azure.servicebus.aio import ServiceBusClient as AsyncServiceBusClient
from azure.servicebus.exceptions import MessageSizeExceededError, ServiceBusError

from config import ServiceBusConfig
from order import Order
from service_bus_common import create_order_message, log_service_bus_error


class OrderSender:
    def __init__(self, config: ServiceBusConfig) -> None:
        self._config = config

    def send_order(self, order: Order) -> None:
        try:
            with DefaultAzureCredential() as credential:
                with ServiceBusClient(
                    self._config.fully_qualified_namespace, credential
                ) as client:
                    with client.get_queue_sender(
                        queue_name=self._config.queue_name
                    ) as sender:
                        sender.send_messages(create_order_message(order))
        except ServiceBusError as exc:
            log_service_bus_error(exc, self._config.queue_name, "send")
            raise

    def send_orders(self, orders: Iterable[Order]) -> None:
        try:
            with DefaultAzureCredential() as credential:
                with ServiceBusClient(
                    self._config.fully_qualified_namespace, credential
                ) as client:
                    with client.get_queue_sender(
                        queue_name=self._config.queue_name
                    ) as sender:
                        batch = sender.create_message_batch()
                        batch_count = 0
                        for order in orders:
                            message = create_order_message(order)
                            try:
                                batch.add_message(message)
                                batch_count += 1
                            except MessageSizeExceededError:
                                if batch_count == 0:
                                    raise
                                sender.send_messages(batch)
                                batch = sender.create_message_batch()
                                batch.add_message(message)
                                batch_count = 1
                        if batch_count:
                            sender.send_messages(batch)
        except ServiceBusError as exc:
            log_service_bus_error(exc, self._config.queue_name, "batch send")
            raise


class AsyncOrderSender:
    def __init__(self, config: ServiceBusConfig) -> None:
        self._config = config

    async def send_order(self, order: Order) -> None:
        try:
            async with AsyncDefaultAzureCredential() as credential:
                async with AsyncServiceBusClient(
                    self._config.fully_qualified_namespace, credential
                ) as client:
                    async with client.get_queue_sender(
                        queue_name=self._config.queue_name
                    ) as sender:
                        await sender.send_messages(create_order_message(order))
        except ServiceBusError as exc:
            log_service_bus_error(exc, self._config.queue_name, "async send")
            raise

    async def send_orders(self, orders: Iterable[Order]) -> None:
        try:
            async with AsyncDefaultAzureCredential() as credential:
                async with AsyncServiceBusClient(
                    self._config.fully_qualified_namespace, credential
                ) as client:
                    async with client.get_queue_sender(
                        queue_name=self._config.queue_name
                    ) as sender:
                        batch = await sender.create_message_batch()
                        batch_count = 0
                        for order in orders:
                            message = create_order_message(order)
                            try:
                                batch.add_message(message)
                                batch_count += 1
                            except MessageSizeExceededError:
                                if batch_count == 0:
                                    raise
                                await sender.send_messages(batch)
                                batch = await sender.create_message_batch()
                                batch.add_message(message)
                                batch_count = 1
                        if batch_count:
                            await sender.send_messages(batch)
        except ServiceBusError as exc:
            log_service_bus_error(exc, self._config.queue_name, "async batch send")
            raise
