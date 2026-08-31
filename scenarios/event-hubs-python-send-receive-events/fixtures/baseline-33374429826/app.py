import asyncio
import os
import sys
from typing import Optional

from azure.eventhub import EventData
from azure.eventhub.aio import EventHubConsumerClient, EventHubProducerClient
from azure.eventhub.extensions.checkpointstoreblobaio import BlobCheckpointStore


EVENT_COUNT = 10


def required_environment_variable(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Required environment variable {name} is not set")
    return value


async def on_event(partition_context, event: Optional[EventData]) -> None:
    if event is None:
        return

    print(event.body_as_str(encoding="UTF-8"), flush=True)
    await partition_context.update_checkpoint(event)


async def on_error(partition_context, error: Exception) -> None:
    partition = (
        partition_context.partition_id if partition_context is not None else "unknown"
    )
    print(
        f"Receive error on partition {partition}: {error}",
        file=sys.stderr,
        flush=True,
    )


async def main() -> None:
    event_hub_connection_string = required_environment_variable(
        "EVENT_HUB_CONNECTION_STRING"
    )
    event_hub_name = required_environment_variable("EVENT_HUB_NAME")
    blob_connection_string = required_environment_variable(
        "BLOB_STORAGE_CONNECTION_STRING"
    )
    blob_container_name = required_environment_variable("BLOB_CONTAINER_NAME")
    consumer_group = os.getenv("EVENT_HUB_CONSUMER_GROUP", "$Default")

    try:
        receive_duration = float(os.getenv("RECEIVE_DURATION_SECONDS", "30"))
    except ValueError as error:
        raise ValueError("RECEIVE_DURATION_SECONDS must be a number") from error
    if receive_duration <= 0:
        raise ValueError("RECEIVE_DURATION_SECONDS must be greater than zero")

    producer: Optional[EventHubProducerClient] = None
    consumer: Optional[EventHubConsumerClient] = None

    try:
        producer = EventHubProducerClient.from_connection_string(
            conn_str=event_hub_connection_string,
            eventhub_name=event_hub_name,
        )
        batch = await producer.create_batch()
        for event_number in range(1, EVENT_COUNT + 1):
            batch.add(
                EventData(
                    f"Event {event_number}",
                    application_properties={"event_number": event_number},
                )
            )
        await producer.send_batch(batch)
        print(f"Sent {EVENT_COUNT} events", flush=True)

        checkpoint_store = BlobCheckpointStore.from_connection_string(
            blob_connection_string,
            blob_container_name,
        )
        consumer = EventHubConsumerClient.from_connection_string(
            conn_str=event_hub_connection_string,
            consumer_group=consumer_group,
            eventhub_name=event_hub_name,
            checkpoint_store=checkpoint_store,
        )

        print(f"Receiving events for {receive_duration:g} seconds", flush=True)
        try:
            await asyncio.wait_for(
                consumer.receive(
                    on_event=on_event,
                    on_error=on_error,
                    starting_position="-1",
                ),
                timeout=receive_duration,
            )
        except asyncio.TimeoutError:
            print("Receive period completed", flush=True)
    finally:
        if consumer is not None:
            await consumer.close()
        if producer is not None:
            await producer.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Stopped by user", file=sys.stderr)
    except Exception as error:
        print(f"Application failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
