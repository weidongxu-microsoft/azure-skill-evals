import os

from azure.servicebus import ServiceBusClient, ServiceBusMessage
from azure.servicebus.exceptions import MessageSizeExceededError


def main() -> None:
    connection_string = os.environ["SERVICE_BUS_CONNECTION_STRING"]
    queue_name = os.environ["SERVICE_BUS_QUEUE_NAME"]
    topic_name = os.environ["SERVICE_BUS_TOPIC_NAME"]
    subscription_name = os.environ["SERVICE_BUS_SUBSCRIPTION_NAME"]

    with ServiceBusClient.from_connection_string(connection_string) as client:
        with client.get_queue_sender(queue_name=queue_name) as sender:
            sender.send_messages(ServiceBusMessage("standalone queue message"))

            batch = sender.create_message_batch()
            for index in range(5):
                try:
                    batch.add_message(ServiceBusMessage(f"batch message {index}"))
                except MessageSizeExceededError:
                    raise RuntimeError("A batch message did not fit") from None
            sender.send_messages(batch)

        with client.get_queue_receiver(
            queue_name=queue_name,
            max_wait_time=5,
        ) as receiver:
            messages = receiver.receive_messages(
                max_message_count=5,
                max_wait_time=5,
            )
            for message in messages:
                print(message.body)
                receiver.complete_message(message)

        with client.get_topic_sender(topic_name=topic_name) as sender:
            sender.send_messages(ServiceBusMessage("topic message"))

        with client.get_subscription_receiver(
            topic_name=topic_name,
            subscription_name=subscription_name,
            max_wait_time=5,
        ) as receiver:
            messages = receiver.receive_messages(
                max_message_count=5,
                max_wait_time=5,
            )
            for message in messages:
                print(message.body)
                receiver.complete_message(message)


if __name__ == "__main__":
    main()
