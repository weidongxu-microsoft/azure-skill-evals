from __future__ import annotations

import asyncio
import logging
from decimal import Decimal
from uuid import uuid4

from config import ServiceBusConfig
from dead_letter import AsyncDeadLetterReprocessor, DeadLetterReprocessor
from order import Order
from processors import AsyncOrderProcessor, OrderProcessor
from senders import AsyncOrderSender, OrderSender


def sample_order(prefix: str) -> Order:
    return Order(
        order_id=f"{prefix}-{uuid4()}",
        customer_name=f"{prefix}-sample-customer",
        product="Azure-compatible widget",
        quantity=2,
        total_price=Decimal("49.98"),
    )


def run_synchronous_cycle(config: ServiceBusConfig) -> None:
    sender = OrderSender(config)
    sender.send_order(sample_order("sync"))
    OrderProcessor(config).process()
    DeadLetterReprocessor(config, sender).reprocess()


async def run_asynchronous_cycle(config: ServiceBusConfig) -> None:
    sender = AsyncOrderSender(config)
    await sender.send_order(sample_order("async"))
    await AsyncOrderProcessor(config).process()
    await AsyncDeadLetterReprocessor(config, sender).reprocess()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    config = ServiceBusConfig.from_environment()
    run_synchronous_cycle(config)
    asyncio.run(run_asynchronous_cycle(config))


if __name__ == "__main__":
    main()
