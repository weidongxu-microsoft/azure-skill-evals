using Azure.Identity;
using Azure.Messaging.ServiceBus;

string serviceBusNamespace =
    Environment.GetEnvironmentVariable("SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE")
    ?? throw new InvalidOperationException(
        "Set SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE before running.");
string queueName =
    Environment.GetEnvironmentVariable("SERVICE_BUS_QUEUE_NAME")
    ?? throw new InvalidOperationException(
        "Set SERVICE_BUS_QUEUE_NAME before running.");
string topicName =
    Environment.GetEnvironmentVariable("SERVICE_BUS_TOPIC_NAME")
    ?? throw new InvalidOperationException(
        "Set SERVICE_BUS_TOPIC_NAME before running.");
string subscriptionName =
    Environment.GetEnvironmentVariable("SERVICE_BUS_SUBSCRIPTION_NAME")
    ?? throw new InvalidOperationException(
        "Set SERVICE_BUS_SUBSCRIPTION_NAME before running.");

await using var client = new ServiceBusClient(
    serviceBusNamespace,
    new DefaultAzureCredential());
await using var queueSender = client.CreateSender(queueName);
await using var queueReceiver = client.CreateReceiver(queueName);
await using var processor = client.CreateProcessor(
    queueName,
    new ServiceBusProcessorOptions { AutoCompleteMessages = false });
await using var topicSender = client.CreateSender(topicName);
await using var subscriptionReceiver =
    client.CreateReceiver(topicName, subscriptionName);

await queueSender.SendMessageAsync(
    new ServiceBusMessage("A single queue message"));

using ServiceBusMessageBatch batch =
    await queueSender.CreateMessageBatchAsync();
for (int messageNumber = 0; messageNumber < 5; messageNumber++)
{
    var message = new ServiceBusMessage($"Batch message {messageNumber}");
    if (!batch.TryAddMessage(message))
    {
        throw new InvalidOperationException(
            $"Batch message {messageNumber} is too large.");
    }
}
await queueSender.SendMessagesAsync(batch);

ServiceBusReceivedMessage? received =
    await queueReceiver.ReceiveMessageAsync(TimeSpan.FromSeconds(30));
if (received is not null)
{
    Console.WriteLine(received.Body.ToString());
    await queueReceiver.CompleteMessageAsync(received);
}

await topicSender.SendMessageAsync(
    new ServiceBusMessage("A topic message"));
ServiceBusReceivedMessage? topicMessage =
    await subscriptionReceiver.ReceiveMessageAsync(
        TimeSpan.FromSeconds(30));
if (topicMessage is not null)
{
    Console.WriteLine(topicMessage.Body.ToString());
    await subscriptionReceiver.CompleteMessageAsync(topicMessage);
}

processor.ProcessMessageAsync += ProcessMessageAsync;
processor.ProcessErrorAsync += ProcessErrorAsync;
try
{
    await processor.StartProcessingAsync();
    await Task.Delay(TimeSpan.FromSeconds(30));
}
finally
{
    await processor.StopProcessingAsync();
}

static async Task ProcessMessageAsync(ProcessMessageEventArgs args)
{
    Console.WriteLine(args.Message.Body.ToString());
    await args.CompleteMessageAsync(args.Message);
}

static Task ProcessErrorAsync(ProcessErrorEventArgs args)
{
    Console.Error.WriteLine(args.Exception);
    return Task.CompletedTask;
}
