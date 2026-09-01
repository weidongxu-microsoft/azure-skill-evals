import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateDotnetCheck,
  loadDotnetWorkspace,
} from "../../languages/dotnet/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/service-bus-dotnet-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadDotnetWorkspace(goldenRoot);

function workspace(source, project = completeWorkspace.project) {
  return { ...completeWorkspace, project, source };
}

function manifest({ target = "net8.0", version = "7.20.2" } = {}) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>${target}</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Azure.Messaging.ServiceBus"
                      Version="${version}" />
  </ItemGroup>
</Project>`;
}

test.skip("golden passes the nine-rule contract and shared lifecycle", () => {
  assert.equal(ruleNames().length, 9);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  assert.equal(
    evaluateDotnetCheck("language/client-lifecycle", completeWorkspace),
    true,
  );
});

test.skip("source manifest requires one active pinned net8 project", () => {
  const propertyManifest = `<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
      <Net>net8.0</Net>
      <TargetFrameworks>net7.0;$(Net)</TargetFrameworks>
      <ServiceBusVersion>7.20.2</ServiceBusVersion>
    </PropertyGroup>
    <ItemGroup Condition="true">
      <PackageReference Include="azure.messaging.servicebus">
        <Version>[$(ServiceBusVersion)]</Version>
      </PackageReference>
    </ItemGroup>
  </Project>`;
  for (const project of [manifest(), propertyManifest]) {
    assert.equal(
      evaluateRule(
        "prompt/source-manifest",
        workspace(completeWorkspace.source, project),
      ),
      true,
    );
  }

  const invalid = [
    manifest({ target: "net7.0" }),
    manifest({ version: "7.20.1" }),
    manifest({ version: "7.*" }),
    manifest().replace(
      '<PackageReference Include="Azure.Messaging.ServiceBus"',
      '<PackageReference Condition="false" Include="Azure.Messaging.ServiceBus"',
    ),
    manifest().replace(
      '<PackageReference Include="Azure.Messaging.ServiceBus"',
      '<!-- <PackageReference Include="Azure.Messaging.ServiceBus"',
    ).replace("/>", "/> -->"),
    `${manifest({ target: "net7.0" })}${manifest({ version: "0.0.0" })}`,
    `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
      <Choose>
        <When Condition="true">
          <ItemGroup>
            <PackageReference Include="Other.Package" Version="1.0.0" />
          </ItemGroup>
        </When>
        <Otherwise>
          <ItemGroup>
            <PackageReference Include="Azure.Messaging.ServiceBus"
                              Version="7.20.2" />
          </ItemGroup>
        </Otherwise>
      </Choose>
    </Project>`,
  ];
  for (const project of invalid) {
    assert.equal(
      evaluateRule(
        "prompt/source-manifest",
        workspace(completeWorkspace.source, project),
      ),
      false,
      project,
    );
  }
});

test.skip("focused golden omissions fail their own rule", () => {
  const cases = [
    [
      "prompt/client-configuration",
      completeWorkspace.source.replace(
        "new DefaultAzureCredential()",
        "credential",
      ),
    ],
    [
      "prompt/queue-single-message",
      completeWorkspace.source.replace(
        "queueSender.SendMessageAsync(",
        "otherSender.SendMessageAsync(",
      ),
    ],
    [
      "prompt/queue-five-message-batch",
      completeWorkspace.source.replace(
        "messageNumber < 5",
        "messageNumber < 4",
      ),
    ],
    [
      "prompt/queue-receive-body",
      completeWorkspace.source.replace(
        "Console.WriteLine(received.Body.ToString());",
        'Console.WriteLine("received");',
      ),
    ],
    [
      "prompt/complete-same-message",
      completeWorkspace.source.replace(
        "queueReceiver.CompleteMessageAsync(received)",
        "queueReceiver.CompleteMessageAsync(topicMessage)",
      ),
    ],
    [
      "prompt/processor-handlers",
      completeWorkspace.source.replace(
        "processor.ProcessErrorAsync += ProcessErrorAsync;",
        "",
      ),
    ],
    [
      "prompt/topic-subscription",
      completeWorkspace.source.replace(
        "client.CreateReceiver(topicName, subscriptionName)",
        "client.CreateReceiver(queueName)",
      ),
    ],
    [
      "prompt/resource-lifecycle",
      completeWorkspace.source.replace(
        "await using var topicSender",
        "var topicSender",
      ),
    ],
  ];
  for (const [rule, source] of cases) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test.skip("queue batch tracks exact count, failure handling, and batch identity", () => {
  const batchRule = "prompt/queue-five-message-batch";
  const invalid = [
    completeWorkspace.source.replace(
      "if (!batch.TryAddMessage(message))",
      "if (CanContinue())",
    ),
    completeWorkspace.source.replace(
      "if (!batch.TryAddMessage(message))",
      "batch.TryAddMessage(message); if (false)",
    ),
    completeWorkspace.source.replace(
      "queueSender.SendMessagesAsync(batch)",
      "queueSender.SendMessagesAsync(otherBatch)",
    ),
    completeWorkspace.source.replace(
      "queueSender.SendMessagesAsync(batch)",
      "topicSender.SendMessagesAsync(batch)",
    ),
    completeWorkspace.source.replace(
      "messageNumber++",
      "messageNumber += 2",
    ),
    completeWorkspace.source.replace(
      "for (int messageNumber = 0; messageNumber < 5; messageNumber++)",
      `var message = new ServiceBusMessage("reused");
for (int messageNumber = 0; messageNumber < 5; messageNumber++)`,
    ).replace(
      '    var message = new ServiceBusMessage($"Batch message {messageNumber}");',
      "",
    ),
    completeWorkspace.source.replace(
      /throw new InvalidOperationException\(\r?\n            \$"Batch message \{messageNumber\} is too large\."\);/,
      `Console.Error.WriteLine(
            $"Batch message {messageNumber} is too large.");`,
    ),
  ];
  for (const source of invalid) {
    assert.equal(evaluateRule(batchRule, workspace(source)), false);
  }

  const assigned = completeWorkspace.source.replace(
    "if (!batch.TryAddMessage(message))",
    `bool added = batch.TryAddMessage(message);
    if (!added)`,
  );
  assert.equal(evaluateRule(batchRule, workspace(assigned)), true);
});

test.skip("five explicit batch additions must use distinct new message objects", () => {
  const additions = Array.from(
    { length: 5 },
    () => `if (!batch.TryAddMessage(message))
{
    throw new InvalidOperationException("message did not fit");
}`,
  ).join("\n");
  const reused = completeWorkspace.source.replace(
    /for \(int messageNumber = 0; messageNumber < 5; messageNumber\+\+\)\r?\n\{[\s\S]*?\r?\n\}/,
    `var message = new ServiceBusMessage("reused");
${additions}`,
  );
  assert.equal(
    evaluateRule("prompt/queue-five-message-batch", workspace(reused)),
    false,
  );
});

test.skip("batch paths reset on rebuild and reject conditional underfilling", () => {
  const rebuilt = completeWorkspace.source.replace(
    "using ServiceBusMessageBatch batch =",
    `using ServiceBusMessageBatch discarded =
    await queueSender.CreateMessageBatchAsync();
using ServiceBusMessageBatch batch =`,
  );
  assert.equal(
    evaluateRule("prompt/queue-five-message-batch", workspace(rebuilt)),
    true,
  );

  const conditional = completeWorkspace.source
    .replace(
      "for (int messageNumber = 0; messageNumber < 5; messageNumber++)",
      "if (shouldAdd)\n{\nfor (int messageNumber = 0; messageNumber < 5; messageNumber++)",
    )
    .replace(
      "await queueSender.SendMessagesAsync(batch);",
      "}\nawait queueSender.SendMessagesAsync(batch);",
    );
  assert.equal(
    evaluateRule("prompt/queue-five-message-batch", workspace(conditional)),
    false,
  );
});

test.skip("batch call order and every TryAdd false path are enforced", () => {
  const sendBeforeAdd = completeWorkspace.source
    .replace(
      "for (int messageNumber = 0; messageNumber < 5; messageNumber++)",
      `await queueSender.SendMessagesAsync(batch);
for (int messageNumber = 0; messageNumber < 5; messageNumber++)`,
    );
  const partialAbort = completeWorkspace.source.replace(
    /throw new InvalidOperationException\(\r?\n            \$"Batch message \{messageNumber\} is too large\."\);/,
    `if (shouldAbort)
        {
            throw new InvalidOperationException("too large");
        }`,
  );
  for (const source of [sendBeforeAdd, partialAbort]) {
    assert.equal(
      evaluateRule("prompt/queue-five-message-batch", workspace(source)),
      false,
    );
  }

  const completeAbort = completeWorkspace.source.replace(
    /throw new InvalidOperationException\(\r?\n            \$"Batch message \{messageNumber\} is too large\."\);/,
    `if (shouldThrow)
        {
            throw new InvalidOperationException("too large");
        }
        else
        {
            return;
        }`,
  );
  assert.equal(
    evaluateRule("prompt/queue-five-message-batch", workspace(completeAbort)),
    true,
  );
});

test.skip("pull receives require a finite count and bounded timeout", () => {
  const unboundedQueue = completeWorkspace.source.replace(
    "queueReceiver.ReceiveMessageAsync(TimeSpan.FromSeconds(30))",
    "queueReceiver.ReceiveMessageAsync()",
  );
  const unboundedTopic = completeWorkspace.source.replace(
    /subscriptionReceiver\.ReceiveMessageAsync\(\r?\n        TimeSpan\.FromSeconds\(30\)\)/,
    "subscriptionReceiver.ReceiveMessageAsync()",
  );
  assert.equal(
    evaluateRule("prompt/queue-receive-body", workspace(unboundedQueue)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/topic-subscription", workspace(unboundedTopic)),
    false,
  );
});

test.skip("collection receives require loop coverage unless max count is one", () => {
  const collection = completeWorkspace.source.replace(
    /ServiceBusReceivedMessage\? received =\r?\n    await queueReceiver\.ReceiveMessageAsync\(TimeSpan\.FromSeconds\(30\)\);\r?\nif \(received is not null\)\r?\n\{\r?\n    Console\.WriteLine\(received\.Body\.ToString\(\)\);\r?\n    await queueReceiver\.CompleteMessageAsync\(received\);\r?\n\}/,
    `var receivedMessages = await queueReceiver.ReceiveMessagesAsync(
    MAX_COUNT, TimeSpan.FromSeconds(30));
foreach (var received in receivedMessages)
{
    Console.WriteLine(received.Body.ToString());
    await queueReceiver.CompleteMessageAsync(received);
    break;
}`,
  );
  assert.equal(
    evaluateRule(
      "prompt/complete-same-message",
      workspace(collection.replace("MAX_COUNT", "2")),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/complete-same-message",
      workspace(collection.replace("MAX_COUNT", "1")),
    ),
    true,
  );
});

test.skip("receive aliases snapshot numeric and timeout values in source order", () => {
  const collection = completeWorkspace.source.replace(
    /ServiceBusReceivedMessage\? received =\r?\n    await queueReceiver\.ReceiveMessageAsync\(TimeSpan\.FromSeconds\(30\)\);\r?\nif \(received is not null\)\r?\n\{\r?\n    Console\.WriteLine\(received\.Body\.ToString\(\)\);\r?\n    await queueReceiver\.CompleteMessageAsync\(received\);\r?\n\}/,
    `int requested = 1;
int maximum = requested;
requested = 3;
int seconds = 30;
TimeSpan timeout = TimeSpan.FromSeconds(seconds);
seconds = 0;
var receivedMessages = await queueReceiver.ReceiveMessagesAsync(
    maximum, timeout);
foreach (var received in receivedMessages)
{
    Console.WriteLine(received.Body.ToString());
    await queueReceiver.CompleteMessageAsync(received);
    break;
}`,
  );
  assert.equal(
    evaluateRule("prompt/complete-same-message", workspace(collection)),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/complete-same-message",
      workspace(collection.replace("int maximum = requested;", "int maximum = 2;")),
    ),
    false,
  );
});

test.skip("unknown receive counts require full collection iteration", () => {
  const collection = completeWorkspace.source.replace(
    /ServiceBusReceivedMessage\? received =\r?\n    await queueReceiver\.ReceiveMessageAsync\(TimeSpan\.FromSeconds\(30\)\);\r?\nif \(received is not null\)\r?\n\{\r?\n    Console\.WriteLine\(received\.Body\.ToString\(\)\);\r?\n    await queueReceiver\.CompleteMessageAsync\(received\);\r?\n\}/,
    `int maximum = int.Parse(
    Environment.GetEnvironmentVariable("SERVICE_BUS_RECEIVE_MAX") ?? "1");
var receivedMessages = await queueReceiver.ReceiveMessagesAsync(
    maximum, TimeSpan.FromSeconds(30));
foreach (var received in receivedMessages)
{
    Console.WriteLine(received.Body.ToString());
    await queueReceiver.CompleteMessageAsync(received);
}`,
  );
  assert.equal(
    evaluateRule("prompt/complete-same-message", workspace(collection)),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/complete-same-message",
      workspace(
        collection.replace(
          "await queueReceiver.CompleteMessageAsync(received);",
          `await queueReceiver.CompleteMessageAsync(received);
    break;`,
        ),
      ),
    ),
    false,
  );
});

test.skip("receive helpers use defaults unless explicit arguments override them", () => {
  const helper = `
static async Task ReceiveQueueAsync(
    ServiceBusReceiver receiver, int maximum = 1, int seconds = 30)
{
    var messages = await receiver.ReceiveMessagesAsync(
        maximum, TimeSpan.FromSeconds(seconds));
    foreach (var message in messages)
    {
        Console.WriteLine(message.Body.ToString());
        await receiver.CompleteMessageAsync(message);
        break;
    }
}

`;
  const delegated = completeWorkspace.source.replace(
    /ServiceBusReceivedMessage\? received =\r?\n    await queueReceiver\.ReceiveMessageAsync\(TimeSpan\.FromSeconds\(30\)\);\r?\nif \(received is not null\)\r?\n\{\r?\n    Console\.WriteLine\(received\.Body\.ToString\(\)\);\r?\n    await queueReceiver\.CompleteMessageAsync\(received\);\r?\n\}/,
    "await ReceiveQueueAsync(queueReceiver);",
  ).replace("static async Task ProcessMessageAsync", helper +
    "static async Task ProcessMessageAsync");

  const valid = [
    "ReceiveQueueAsync(queueReceiver);",
    "ReceiveQueueAsync(queueReceiver, seconds: 30);",
    "ReceiveQueueAsync(seconds: 30, receiver: queueReceiver, maximum: 1);",
  ];
  for (const invocation of valid) {
    assert.equal(
      evaluateRule(
        "prompt/complete-same-message",
        workspace(
          delegated.replace(
            "ReceiveQueueAsync(queueReceiver);",
            invocation,
          ),
        ),
      ),
      true,
      invocation,
    );
  }

  const invalid = [
    "ReceiveQueueAsync(queueReceiver, maximum: 2);",
    "ReceiveQueueAsync(queueReceiver, 0, 30);",
    "ReceiveQueueAsync(queueReceiver, -1, 30);",
    "ReceiveQueueAsync(receiver: queueReceiver, 1);",
    "ReceiveQueueAsync(queueReceiver, receiver: queueReceiver);",
    "ReceiveQueueAsync(queueReceiver, unknown: 30);",
    "ReceiveQueueAsync(queueReceiver, 1, 30, 4);",
    "ReceiveQueueAsync(maximum: 1, seconds: 30);",
    "ReceiveQueueAsync(queueReceiver, Maximum: 1);",
  ];
  for (const invocation of invalid) {
    assert.equal(
      evaluateRule(
        "prompt/complete-same-message",
        workspace(
          delegated.replace(
            "ReceiveQueueAsync(queueReceiver);",
            invocation,
          ),
        ),
      ),
      false,
      invocation,
    );
  }
});

test.skip("receive output and settlement preserve receiver and message identities", () => {
  const wrongReceiver = completeWorkspace.source.replace(
    "queueReceiver.CompleteMessageAsync(received)",
    "subscriptionReceiver.CompleteMessageAsync(received)",
  );
  assert.equal(
    evaluateRule("prompt/complete-same-message", workspace(wrongReceiver)),
    false,
  );

  const premature = completeWorkspace.source.replace(
    /Console\.WriteLine\(received\.Body\.ToString\(\)\);\r?\n    await queueReceiver\.CompleteMessageAsync\(received\);/,
    `await queueReceiver.CompleteMessageAsync(received);
    Console.WriteLine(received.Body.ToString());`,
  );
  assert.equal(
    evaluateRule("prompt/complete-same-message", workspace(premature)),
    false,
  );

  const alias = completeWorkspace.source.replace(
    "Console.WriteLine(received.Body.ToString());",
    `var current = received;
    string body = current.Body.ToString();
    Console.WriteLine(body);`,
  ).replace(
    "queueReceiver.CompleteMessageAsync(received)",
    "queueReceiver.CompleteMessageAsync(current)",
  );
  assert.equal(
    evaluateRule("prompt/queue-receive-body", workspace(alias)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/complete-same-message", workspace(alias)),
    true,
  );
});

test.skip("normal body processing must dominate completion", () => {
  const conditionalOutput = completeWorkspace.source.replace(
    "Console.WriteLine(received.Body.ToString());",
    `if (shouldPrint)
    {
        Console.WriteLine(received.Body.ToString());
    }`,
  );
  const finallyCompletion = completeWorkspace.source.replace(
    "await queueReceiver.CompleteMessageAsync(received);",
    `try
    {
    }
    finally
    {
        await queueReceiver.CompleteMessageAsync(received);
    }`,
  );
  const catchCompletion = completeWorkspace.source.replace(
    "await queueReceiver.CompleteMessageAsync(received);",
    `try
    {
        throw new InvalidOperationException();
    }
    catch
    {
        await queueReceiver.CompleteMessageAsync(received);
    }`,
  );
  for (const source of [
    conditionalOutput,
    finallyCompletion,
    catchCompletion,
  ]) {
    assert.equal(
      evaluateRule("prompt/complete-same-message", workspace(source)),
      false,
    );
  }
});

test.skip("exclusive settlement branches pass and double settlement fails", () => {
  const exclusive = completeWorkspace.source.replace(
    `Console.WriteLine(received.Body.ToString());
    await queueReceiver.CompleteMessageAsync(received);`,
    `if (shouldRetry)
    {
        await queueReceiver.AbandonMessageAsync(received);
    }
    else
    {
        Console.WriteLine(received.Body.ToString());
        await queueReceiver.CompleteMessageAsync(received);
    }`,
  );
  assert.equal(
    evaluateRule("prompt/complete-same-message", workspace(exclusive)),
    true,
  );

  const twice = completeWorkspace.source.replace(
    "await queueReceiver.CompleteMessageAsync(received);",
    `await queueReceiver.CompleteMessageAsync(received);
    await queueReceiver.DeadLetterMessageAsync(received);`,
  );
  assert.equal(
    evaluateRule("prompt/complete-same-message", workspace(twice)),
    false,
  );
});

test.skip("topic receive prints then settles the exact subscription message", () => {
  const noBody = completeWorkspace.source.replace(
    "Console.WriteLine(topicMessage.Body.ToString());",
    'Console.WriteLine("topic");',
  );
  const wrongMessage = completeWorkspace.source.replace(
    "subscriptionReceiver.CompleteMessageAsync(topicMessage)",
    "subscriptionReceiver.CompleteMessageAsync(received)",
  );
  const premature = completeWorkspace.source.replace(
    /Console\.WriteLine\(topicMessage\.Body\.ToString\(\)\);\r?\n    await subscriptionReceiver\.CompleteMessageAsync\(topicMessage\);/,
    `await subscriptionReceiver.CompleteMessageAsync(topicMessage);
    Console.WriteLine(topicMessage.Body.ToString());`,
  );
  for (const source of [noBody, wrongMessage, premature]) {
    assert.equal(
      evaluateRule("prompt/topic-subscription", workspace(source)),
      false,
    );
  }
});

test.skip("processor handlers must be live, useful, and settle their own message", () => {
  const wrongMessage = completeWorkspace.source.replace(
    "args.CompleteMessageAsync(args.Message)",
    "args.CompleteMessageAsync(otherMessage)",
  );
  const deadHandlers = completeWorkspace.source
    .replace("processor.ProcessMessageAsync += ProcessMessageAsync;", "")
    .replace("processor.ProcessErrorAsync += ProcessErrorAsync;", "");
  const wrongProcessor = completeWorkspace.source
    .replace(
      "processor.ProcessMessageAsync += ProcessMessageAsync;",
      "otherProcessor.ProcessMessageAsync += ProcessMessageAsync;",
    )
    .replace(
      "processor.ProcessErrorAsync += ProcessErrorAsync;",
      "otherProcessor.ProcessErrorAsync += ProcessErrorAsync;",
    );
  const silentError = completeWorkspace.source.replace(
    "Console.Error.WriteLine(args.Exception);",
    "return Task.CompletedTask;",
  );
  for (const source of [
    wrongMessage,
    deadHandlers,
    wrongProcessor,
    silentError,
  ]) {
    assert.equal(
      evaluateRule("prompt/processor-handlers", workspace(source)),
      false,
    );
  }
});

test.skip("inline handlers and separately configured processor options pass", () => {
  const source = completeWorkspace.source
    .replace(
      `await using var processor = client.CreateProcessor(
    queueName,
    new ServiceBusProcessorOptions { AutoCompleteMessages = false });`,
      `var processorOptions = new ServiceBusProcessorOptions
{
    AutoCompleteMessages = false
};
await using var processor =
    client.CreateProcessor(queueName, processorOptions);`,
    )
    .replace(
      "processor.ProcessMessageAsync += ProcessMessageAsync;",
      `processor.ProcessMessageAsync += async args =>
{
    Console.WriteLine(args.Message.Body.ToString());
    await args.CompleteMessageAsync(args.Message);
};`,
    )
    .replace(
      "processor.ProcessErrorAsync += ProcessErrorAsync;",
      `processor.ProcessErrorAsync += args =>
{
    Console.Error.WriteLine(args.Exception);
    return Task.CompletedTask;
};`,
    );
  assert.equal(
    evaluateRule("prompt/processor-handlers", workspace(source)),
    true,
  );

  const autoComplete = source.replace(
    "AutoCompleteMessages = false",
    "AutoCompleteMessages = true",
  );
  assert.equal(
    evaluateRule("prompt/processor-handlers", workspace(autoComplete)),
    false,
  );
});

test.skip("processor lifecycle rejects immediate, unawaited, or unguaranteed stop", () => {
  const immediate = completeWorkspace.source.replace(
    "await Task.Delay(TimeSpan.FromSeconds(30));",
    "",
  );
  const unawaited = completeWorkspace.source.replace(
    "await processor.StopProcessingAsync();",
    "processor.StopProcessingAsync();",
  );
  const unguaranteed = completeWorkspace.source
    .replace("try\r\n{", "{")
    .replace("finally\r\n{", "{")
    .replace("try\n{", "{")
    .replace("finally\n{", "{");
  for (const source of [immediate, unawaited, unguaranteed]) {
    assert.equal(
      evaluateRule("prompt/resource-lifecycle", workspace(source)),
      false,
    );
  }
});

test.skip("resource lifecycle rejects early disposal and secondary client leaks", () => {
  const earlySender = completeWorkspace.source
    .replace("await using var queueSender", "var queueSender")
    .replace(
      "await queueSender.SendMessageAsync(",
      "await queueSender.DisposeAsync();\nawait queueSender.SendMessageAsync(",
    );
  const earlyClient = completeWorkspace.source
    .replace("await using var client", "var client")
    .replace(
      "await queueSender.SendMessageAsync(",
      "await client.DisposeAsync();\nawait queueSender.SendMessageAsync(",
    );
  const leakedClient = completeWorkspace.source.replace(
    "await using var queueSender",
    `var leakedClient = new ServiceBusClient(
    serviceBusNamespace,
    new DefaultAzureCredential());
await using var queueSender`,
  );
  const earlyThenImplicit = completeWorkspace.source.replace(
    "await queueSender.SendMessageAsync(",
    "await queueSender.DisposeAsync();\nawait queueSender.SendMessageAsync(",
  );
  for (const source of [
    earlySender,
    earlyClient,
    earlyThenImplicit,
    leakedClient,
  ]) {
    assert.equal(
      evaluateRule("prompt/resource-lifecycle", workspace(source)),
      false,
    );
  }
});

test.skip("explicit cleanup attempts require independent finally guards", () => {
  const sequential = completeWorkspace.source
    .replace("await using var queueSender", "var queueSender")
    .replace("await using var queueReceiver", "var queueReceiver")
    .replace(
      "await processor.StopProcessingAsync();",
      `await processor.StopProcessingAsync();
        await queueSender.DisposeAsync();
        await queueReceiver.DisposeAsync();`,
    );
  assert.equal(
    evaluateRule("prompt/resource-lifecycle", workspace(sequential)),
    false,
  );

  assert.equal(
    evaluateRule("prompt/resource-lifecycle", completeWorkspace),
    true,
  );
});

test.skip("qualified types, namespace aliases, and reachable factories pass", () => {
  const source = completeWorkspace.source
    .replace(
      "using Azure.Identity;",
      "using Identity = Azure.Identity;",
    )
    .replace(
      "using Azure.Messaging.ServiceBus;",
      `using Azure.Messaging.ServiceBus;
using Messaging = Azure.Messaging.ServiceBus;`,
    )
    .replace(
      "new ServiceBusClient(",
      "new Messaging.ServiceBusClient(",
    )
    .replace(
      "new DefaultAzureCredential()",
      "new Identity.DefaultAzureCredential()",
    )
    .replace(
      "client.CreateSender(queueName)",
      "CreateSender(client, queueName)",
    ) + `
static Messaging.ServiceBusSender CreateSender(
    Messaging.ServiceBusClient client, string entity) =>
    client.CreateSender(entity);
`;
  for (const rule of [
    "prompt/client-configuration",
    "prompt/queue-single-message",
    "prompt/queue-five-message-batch",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("factory objects may keep SDK clients in members", () => {
  const source = completeWorkspace.source.replace(
    "client.CreateSender(queueName)",
    "factory.CreateQueueSender(queueName)",
  ).replace(
    "await using var queueSender",
    `var factory = new SenderFactory(client);
await using var queueSender`,
  ) + `
sealed class SenderFactory
{
    private readonly ServiceBusClient serviceBusClient;

    public SenderFactory(ServiceBusClient client)
    {
        serviceBusClient = client;
    }

    public ServiceBusSender CreateQueueSender(string entity)
    {
        return serviceBusClient.CreateSender(entity);
    }
}
`;
  assert.equal(
    evaluateRule("prompt/queue-single-message", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/queue-five-message-batch", workspace(source)),
    true,
  );
});

test.skip("comments, strings, unreachable code, and dead helpers are decoys", () => {
  const source = `
using Azure.Identity;
using Azure.Messaging.ServiceBus;
string decoy = """
var client = new ServiceBusClient(ns, new DefaultAzureCredential());
var sender = client.CreateSender(queue);
await sender.SendMessageAsync(new ServiceBusMessage("fake"));
""";
if (false)
{
    var client = new ServiceBusClient(ns, new DefaultAzureCredential());
}
static void NeverCalled()
{
    var client = new ServiceBusClient(ns, new DefaultAzureCredential());
}
`;
  assert.equal(
    evaluateRule("prompt/client-configuration", workspace(source)),
    false,
  );
});
