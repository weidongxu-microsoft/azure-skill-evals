# Azure Service Bus order processor

This project sends and processes session-enabled order messages with both the
synchronous and asynchronous Azure Service Bus clients.

Orders whose total price is greater than `1000.00` are high priority. They are
tagged with the `priority=high` application property and scheduled for roughly
30 seconds after they are sent. Other orders are enqueued immediately.

## Setup

1. Create an Azure Service Bus queue with sessions enabled.
2. Grant the signed-in identity Azure Service Bus Data Sender and Data Receiver
   access to the namespace.
3. Install dependencies with `python -m pip install -r requirements.txt`.
4. Set `SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE` and `SERVICE_BUS_QUEUE_NAME`.
5. Authenticate using any method supported by `DefaultAzureCredential`, such as
   `az login`.
6. Run `python main.py`.

The program performs a synchronous send/process/dead-letter-reprocess cycle,
then awaits the equivalent asynchronous cycle. Invalid dead-letter payloads are
left in the dead-letter subqueue for inspection.
