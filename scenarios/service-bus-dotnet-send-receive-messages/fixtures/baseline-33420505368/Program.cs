using Azure.Identity;
using Azure.Messaging.ServiceBus;

string fullyQualifiedNamespace = GetRequiredEnvironmentVariable(
    "AZURE_SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE");
string queueName = GetRequiredEnvironmentVariable("AZURE_SERVICE_BUS_QUEUE_NAME");
string topicName = GetRequiredEnvironmentVariable("AZURE_SERVICE_BUS_TOPIC_NAME");
string subscriptionName = GetRequiredEnvironmentVariable(
    "AZURE_SERVICE_BUS_SUBSCRIPTION_NAME");

await using var client = new ServiceBusClient(
    fullyQualifiedNamespace,
    new DefaultAzureCredential());

await SendQueueMessagesAsync(client, queueName);
await ReceiveQueueMessageAsync(client, queueName);
await ProcessQueueMessagesAsync(client, queueName);
await SendAndReceiveTopicMessageAsync(client, topicName, subscriptionName);

static async Task SendQueueMessagesAsync(ServiceBusClient client, string queueName)
{
    await using ServiceBusSender sender = client.CreateSender(queueName);

    await sender.SendMessageAsync(new ServiceBusMessage("Single queue message"));

    using ServiceBusMessageBatch batch = await sender.CreateMessageBatchAsync();
    for (int i = 1; i <= 5; i++)
    {
        var message = new ServiceBusMessage($"Batched queue message {i}");
        if (!batch.TryAddMessage(message))
        {
            throw new InvalidOperationException(
                $"Message {i} is too large to fit in the Service Bus batch.");
        }
    }

    await sender.SendMessagesAsync(batch);
}

static async Task ReceiveQueueMessageAsync(ServiceBusClient client, string queueName)
{
    await using ServiceBusReceiver receiver = client.CreateReceiver(queueName);
    ServiceBusReceivedMessage? message = await receiver.ReceiveMessageAsync(
        TimeSpan.FromSeconds(30));

    if (message is null)
    {
        throw new TimeoutException("No queue message was received within 30 seconds.");
    }

    Console.WriteLine($"Queue receiver: {message.Body}");
    await receiver.CompleteMessageAsync(message);
}

static async Task ProcessQueueMessagesAsync(ServiceBusClient client, string queueName)
{
    await using ServiceBusProcessor processor = client.CreateProcessor(
        queueName,
        new ServiceBusProcessorOptions
        {
            AutoCompleteMessages = false,
            MaxConcurrentCalls = 1
        });

    var processedMessage = new TaskCompletionSource(
        TaskCreationOptions.RunContinuationsAsynchronously);

    processor.ProcessMessageAsync += async args =>
    {
        Console.WriteLine($"Queue processor: {args.Message.Body}");
        await args.CompleteMessageAsync(args.Message);
        processedMessage.TrySetResult();
    };

    processor.ProcessErrorAsync += args =>
    {
        Console.Error.WriteLine(
            $"Service Bus processor error ({args.ErrorSource}): {args.Exception}");
        return Task.CompletedTask;
    };

    using var shutdown = new CancellationTokenSource(TimeSpan.FromSeconds(30));
    ConsoleCancelEventHandler cancelHandler = (_, eventArgs) =>
    {
        eventArgs.Cancel = true;
        shutdown.Cancel();
    };

    Console.CancelKeyPress += cancelHandler;
    try
    {
        await processor.StartProcessingAsync();
        Task cancellation = Task.Delay(Timeout.InfiniteTimeSpan, shutdown.Token);
        await Task.WhenAny(processedMessage.Task, cancellation);
    }
    finally
    {
        Console.CancelKeyPress -= cancelHandler;
        await processor.StopProcessingAsync();
    }
}

static async Task SendAndReceiveTopicMessageAsync(
    ServiceBusClient client,
    string topicName,
    string subscriptionName)
{
    await using ServiceBusSender sender = client.CreateSender(topicName);
    await using ServiceBusReceiver receiver = client.CreateReceiver(
        topicName,
        subscriptionName);

    await sender.SendMessageAsync(new ServiceBusMessage("Topic message"));

    ServiceBusReceivedMessage? message = await receiver.ReceiveMessageAsync(
        TimeSpan.FromSeconds(30));
    if (message is null)
    {
        throw new TimeoutException("No topic message was received within 30 seconds.");
    }

    Console.WriteLine($"Topic subscription receiver: {message.Body}");
    await receiver.CompleteMessageAsync(message);
}

static string GetRequiredEnvironmentVariable(string name)
{
    string? value = Environment.GetEnvironmentVariable(name);
    if (string.IsNullOrWhiteSpace(value))
    {
        throw new InvalidOperationException(
            $"The required environment variable '{name}' is not set.");
    }

    return value;
}
