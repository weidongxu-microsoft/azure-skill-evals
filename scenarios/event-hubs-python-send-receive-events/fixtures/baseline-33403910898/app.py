import asyncio
import os
import sys
from contextlib import suppress

from azure.core.exceptions import AzureError
from azure.eventhub import EventData
from azure.eventhub.aio import EventHubConsumerClient, EventHubProducerClient
from azure.eventhub.extensions.checkpointstoreblobaio import BlobCheckpointStore


class ConfigurationError(ValueError):
    pass


def required_environment_variable(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ConfigurationError(f"Required environment variable {name} is not set.")
    return value


def receive_timeout() -> float:
    raw_value = os.getenv("RECEIVE_TIMEOUT_SECONDS", "60")
    try:
        value = float(raw_value)
    except ValueError as exc:
        raise ConfigurationError(
            "RECEIVE_TIMEOUT_SECONDS must be a number."
        ) from exc
    if value <= 0:
        raise ConfigurationError("RECEIVE_TIMEOUT_SECONDS must be greater than zero.")
    return value


async def run() -> None:
    event_hub_connection_string = required_environment_variable(
        "EVENT_HUB_CONNECTION_STRING"
    )
    event_hub_name = required_environment_variable("EVENT_HUB_NAME")
    storage_connection_string = required_environment_variable(
        "AZURE_STORAGE_CONNECTION_STRING"
    )
    blob_container_name = required_environment_variable("BLOB_CONTAINER_NAME")
    consumer_group = os.getenv("EVENT_HUB_CONSUMER_GROUP", "$Default")
    timeout = receive_timeout()

    producer = EventHubProducerClient.from_connection_string(
        conn_str=event_hub_connection_string,
        eventhub_name=event_hub_name,
    )
    consumer: EventHubConsumerClient | None = None
    receive_task: asyncio.Task[None] | None = None
    completion_task: asyncio.Task[bool] | None = None

    try:
        checkpoint_store = BlobCheckpointStore.from_connection_string(
            storage_connection_string,
            blob_container_name,
        )
        consumer = EventHubConsumerClient.from_connection_string(
            conn_str=event_hub_connection_string,
            consumer_group=consumer_group,
            eventhub_name=event_hub_name,
            checkpoint_store=checkpoint_store,
        )

        batch = await producer.create_batch()
        for event_number in range(1, 11):
            event = EventData(f"Event {event_number}")
            event.properties = {"event_number": event_number}
            batch.add(event)
        await producer.send_batch(batch)
        print("Sent 10 events.")

        processed_events = 0
        received_ten_events = asyncio.Event()

        async def on_event(partition_context, event: EventData) -> None:
            nonlocal processed_events
            print(
                f"Partition {partition_context.partition_id}: "
                f"{event.body_as_str(encoding='UTF-8')}"
            )
            await partition_context.update_checkpoint(event)
            processed_events += 1
            if processed_events >= 10:
                received_ten_events.set()

        async def on_error(partition_context, error: Exception) -> None:
            partition = (
                partition_context.partition_id
                if partition_context is not None
                else "all partitions"
            )
            print(f"Receive error for {partition}: {error}", file=sys.stderr)

        receive_task = asyncio.create_task(
            consumer.receive(
                on_event=on_event,
                on_error=on_error,
                starting_position="-1",
            )
        )
        completion_task = asyncio.create_task(received_ten_events.wait())
        done, _ = await asyncio.wait(
            {receive_task, completion_task},
            timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )

        if receive_task in done:
            await receive_task
            if not received_ten_events.is_set():
                raise RuntimeError("Event receiving stopped before 10 events were processed.")
        elif completion_task not in done:
            print(
                f"Stopped receiving after {timeout:g} seconds; "
                f"processed {processed_events} event(s).",
                file=sys.stderr,
            )
    finally:
        if completion_task is not None and not completion_task.done():
            completion_task.cancel()
            with suppress(asyncio.CancelledError):
                await completion_task
        try:
            if consumer is not None:
                await consumer.close()
                if receive_task is not None:
                    await receive_task
        finally:
            await producer.close()


def main() -> int:
    try:
        asyncio.run(run())
    except ConfigurationError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2
    except AzureError as exc:
        print(f"Azure operation failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
