from __future__ import annotations

import asyncio
import os
import sys

from azure.eventhub import EventData
from azure.eventhub.aio import EventHubConsumerClient, EventHubProducerClient
from azure.eventhub.exceptions import EventHubError
from azure.eventhub.extensions.checkpointstoreblobaio import BlobCheckpointStore


async def on_event(partition_context, event) -> None:
    print(event.body_as_str(encoding="UTF-8"))
    await partition_context.update_checkpoint(event)


async def on_error(partition_context, error) -> None:
    partition = (
        partition_context.partition_id if partition_context is not None else "all"
    )
    print("Receive error on partition", partition, error, file=sys.stderr)


async def send_events(connection_string: str, event_hub_name: str) -> None:
    async with EventHubProducerClient.from_connection_string(
        conn_str=connection_string,
        eventhub_name=event_hub_name,
    ) as producer:
        event_batch = await producer.create_batch()
        for event_number in range(10):
            event = EventData(f"Event {event_number}")
            event.properties = {"event_number": event_number}
            event_batch.add(event)
        await producer.send_batch(event_batch)


async def receive_events(
    connection_string: str,
    event_hub_name: str,
    storage_connection_string: str,
    checkpoint_container: str,
) -> None:
    checkpoint_store = BlobCheckpointStore.from_connection_string(
        storage_connection_string,
        checkpoint_container,
    )
    async with EventHubConsumerClient.from_connection_string(
        conn_str=connection_string,
        consumer_group="$Default",
        eventhub_name=event_hub_name,
        checkpoint_store=checkpoint_store,
    ) as consumer:
        try:
            await asyncio.wait_for(
                consumer.receive(
                    on_event=on_event,
                    on_error=on_error,
                    starting_position="-1",
                ),
                timeout=30,
            )
        except TimeoutError:
            pass


async def run() -> None:
    connection_string = os.environ["EVENT_HUBS_CONNECTION_STRING"]
    event_hub_name = os.environ["EVENT_HUB_NAME"]
    storage_connection_string = os.environ["BLOB_STORAGE_CONNECTION_STRING"]
    checkpoint_container = os.environ["BLOB_CHECKPOINT_CONTAINER"]

    await send_events(connection_string, event_hub_name)
    await receive_events(
        connection_string,
        event_hub_name,
        storage_connection_string,
        checkpoint_container,
    )


def main() -> int:
    try:
        asyncio.run(run())
    except KeyError as error:
        print(
            f"Missing required environment variable: {error.args[0]}",
            file=sys.stderr,
        )
        return 2
    except EventHubError as error:
        print(f"Event Hubs operation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
