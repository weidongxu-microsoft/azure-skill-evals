import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadServiceBusWorkspace,
  ruleNames,
} from "./tools/service-bus-python-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const goldenWorkspace = loadServiceBusWorkspace(goldenPath);
const goldenSource = goldenWorkspace.sources.join("\n").replaceAll("\r\n", "\n");
const manifest = goldenWorkspace.dependencies;
const sourceRules = ruleNames().filter(
  (name) => name !== "prompt/service-bus-package",
);

function workspace(python, dependencies = manifest, filename = "requirements.txt") {
  return {
    dependencyManifests: [{ content: dependencies, filename }],
    dependencies,
    sources: [python],
  };
}

test("pinned golden passes exactly nine semantic rules", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/service-bus-package",
    "prompt/client-configuration",
    "prompt/queue-single-send",
    "prompt/queue-batch-send",
    "prompt/queue-receive",
    "prompt/message-settlement",
    "prompt/async-client",
    "prompt/topic-subscription",
    "prompt/resource-lifecycle",
  ]);
  assert.match(manifest, /^azure-servicebus==7\.14\.3$/m);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }
});

test("workspace discovery excludes tests, generated code, and prose decoys", () => {
  const root = fileURLToPath(new URL("./.workspace-fixture", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), manifest);
    writeFileSync(join(root, "src", "app.py"), goldenSource);
    writeFileSync(join(root, "tests", "test_decoy.py"), goldenSource);
    writeFileSync(join(root, "generated", "decoy.py"), goldenSource);
    writeFileSync(join(root, "README.md"), goldenSource);

    const discovered = loadServiceBusWorkspace(root);
    assert.deepEqual(discovered.pythonFiles, [join(root, "src", "app.py")]);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, discovered), true, rule);
    }

    writeFileSync(join(root, "src", "app.py"), "print('not an app')\n");
    const decoysOnly = loadServiceBusWorkspace(root);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, decoysOnly), false, rule);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime package declarations accept common manifest forms", () => {
  const cases = [
    ["requirements-prod.txt", "azure-servicebus>=7.14"],
    [
      "pyproject.toml",
      '[project]\ndependencies = ["azure-servicebus~=7.14"]',
    ],
    [
      "pyproject.toml",
      '[tool.poetry.dependencies]\npython = "^3.11"\nazure-servicebus = "7.14.3"',
    ],
    [
      "setup.py",
      'from setuptools import setup\nsetup(install_requires=["azure-servicebus>=7.14"])',
    ],
  ];
  for (const [filename, dependencies] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/service-bus-package",
        workspace("print('app')", dependencies, filename),
      ),
      true,
      filename,
    );
  }
});

test("prose, dev-only declarations, optional groups, and lookalikes fail", () => {
  const cases = [
    ["requirements.txt", "Install azure-servicebus."],
    ["requirements-dev.txt", "azure-servicebus==7.14.3"],
    [
      "pyproject.toml",
      '[project.optional-dependencies]\ndev = ["azure-servicebus"]',
    ],
    ["requirements.txt", "azure-servicebus-checkpointstore==1.0"],
  ];
  for (const [filename, dependencies] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/service-bus-package",
        workspace("print('app')", dependencies, filename),
      ),
      false,
      `${filename}: ${dependencies}`,
    );
  }
});

test("each focused golden mutation fails its owning rule", () => {
  const cases = [
    [
      "prompt/client-configuration",
      'os.environ["SERVICE_BUS_QUEUE_NAME"]',
      '"hard-coded-queue"',
    ],
    [
      "prompt/queue-single-send",
      'sender.send_messages(ServiceBusMessage("standalone queue message"))',
      "pass",
    ],
    ["prompt/queue-batch-send", "range(5)", "range(4)"],
    [
      "prompt/queue-batch-send",
      "except MessageSizeExceededError:",
      "except ValueError:",
    ],
    [
      "prompt/queue-receive",
      "max_message_count=5,\n                max_wait_time=5,",
      "max_message_count=5,",
    ],
    [
      "prompt/message-settlement",
      "receiver.complete_message(message)",
      "receiver.complete_message(ServiceBusMessage('wrong'))",
    ],
    [
      "prompt/topic-subscription",
      'sender.send_messages(ServiceBusMessage("topic message"))',
      "pass",
    ],
  ];
  for (const [rule, from, to] of cases) {
    assert.notEqual(goldenSource.indexOf(from), -1, from);
    assert.equal(
      evaluateRule(rule, workspace(goldenSource.replace(from, to))),
      false,
      rule,
    );
  }
});

test("aliases and reachable helper calls preserve SDK object identity", () => {
  const source = goldenSource
    .replace(
      'sender.send_messages(ServiceBusMessage("standalone queue message"))',
      `send = sender.send_messages
            send(ServiceBusMessage("standalone queue message"))`,
    )
    .replace(
      "                receiver.complete_message(message)",
      `                settle = receiver.complete_message
                settle(message)`,
    );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("reachable helpers may perform sends and process received messages", () => {
  const source = goldenSource
    .replace(
      '            sender.send_messages(ServiceBusMessage("standalone queue message"))',
      "            send_one(sender)",
    )
    .replace(
      "def main() -> None:",
      `def send_one(sender):
    sender.send_messages(ServiceBusMessage("standalone queue message"))


def process(receiver, message):
    print(message.body)
    receiver.complete_message(message)


def main() -> None:`,
    )
    .replaceAll(
      `print(message.body)
                receiver.complete_message(message)`,
      "process(receiver, message)",
    );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("qualified imports and an Entra client configuration are accepted", () => {
  const source = goldenSource
    .replace(
      "import os",
      "import os\nimport azure.identity as identity\nimport azure.servicebus as servicebus",
    )
    .replace(
      "from azure.servicebus import ServiceBusClient, ServiceBusMessage",
      "",
    )
    .replaceAll("ServiceBusMessage", "servicebus.ServiceBusMessage")
    .replace(
      "with ServiceBusClient.from_connection_string(connection_string) as client:",
      `credential = identity.DefaultAzureCredential()
    namespace = os.environ["SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE"]
    with servicebus.ServiceBusClient(
        fully_qualified_namespace=namespace,
        credential=credential,
    ) as client:`,
    );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("a complete aio implementation must await every SDK operation", () => {
  const asyncSource = `
import asyncio
import os
from azure.servicebus import ServiceBusMessage
from azure.servicebus.aio import ServiceBusClient
from azure.servicebus.exceptions import MessageSizeExceededError

async def main():
    connection = os.environ["SERVICE_BUS_CONNECTION_STRING"]
    queue = os.environ["SERVICE_BUS_QUEUE_NAME"]
    topic = os.environ["SERVICE_BUS_TOPIC_NAME"]
    subscription = os.environ["SERVICE_BUS_SUBSCRIPTION_NAME"]
    async with ServiceBusClient.from_connection_string(connection) as client:
        async with client.get_queue_sender(queue_name=queue) as sender:
            await sender.send_messages(ServiceBusMessage("one"))
            batch = await sender.create_message_batch()
            for index in range(5):
                try:
                    batch.add_message(ServiceBusMessage(f"batch {index}"))
                except MessageSizeExceededError:
                    raise
            await sender.send_messages(batch)
        async with client.get_queue_receiver(queue_name=queue) as receiver:
            messages = await receiver.receive_messages(
                max_message_count=5, max_wait_time=5
            )
            for message in messages:
                print(message.body)
                await receiver.complete_message(message)
        async with client.get_topic_sender(topic_name=topic) as sender:
            await sender.send_messages(ServiceBusMessage("topic"))
        async with client.get_subscription_receiver(
            topic_name=topic, subscription_name=subscription
        ) as receiver:
            messages = await receiver.receive_messages(
                max_message_count=5, max_wait_time=5
            )
            for message in messages:
                print(message.body)
                await receiver.complete_message(message)

asyncio.run(main())
`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(asyncSource)), true, rule);
  }

  for (const mutation of [
    asyncSource.replace(
      'await sender.send_messages(ServiceBusMessage("one"))',
      'sender.send_messages(ServiceBusMessage("one"))',
    ),
    asyncSource.replace(
      "messages = await receiver.receive_messages(",
      "messages = receiver.receive_messages(",
    ),
    asyncSource.replace(
      "await receiver.complete_message(message)",
      "receiver.complete_message(message)",
    ),
  ]) {
    assert.equal(
      evaluateRule("prompt/async-client", workspace(mutation)),
      false,
    );
  }
});

test("an unawaited async helper is dead and cannot contribute behavior", () => {
  const source = `
import os
from azure.servicebus import ServiceBusMessage
from azure.servicebus.aio import ServiceBusClient

async def decoy():
    client = ServiceBusClient.from_connection_string(
        os.environ["SERVICE_BUS_CONNECTION_STRING"]
    )
    sender = client.get_queue_sender(
        queue_name=os.environ["SERVICE_BUS_QUEUE_NAME"]
    )
    await sender.send_messages(ServiceBusMessage("not reachable"))

decoy()
`;
  assert.equal(
    evaluateRule("prompt/queue-single-send", workspace(source)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/client-configuration", workspace(source)),
    false,
  );
});

test("fake classes and method-name lookalikes cannot satisfy any source rule", () => {
  const source = `
class ServiceBusClient:
    @classmethod
    def from_connection_string(cls, value):
        return cls()
    def get_queue_sender(self, **kwargs):
        return self
    def get_queue_receiver(self, **kwargs):
        return self
    def send_messages(self, value):
        pass
    def receive_messages(self, **kwargs):
        return [object()]
    def complete_message(self, value):
        pass
    def close(self):
        pass

client = ServiceBusClient.from_connection_string("fake")
sender = client.get_queue_sender(queue_name="fake")
sender.send_messages("fake")
`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test("the sent batch must be the created queue batch with five new messages", () => {
  const wrongBatch = goldenSource.replace(
    "sender.send_messages(batch)",
    "sender.send_messages(other_batch)",
  );
  assert.equal(
    evaluateRule("prompt/queue-batch-send", workspace(wrongBatch)),
    false,
  );

  const reusedMessage = goldenSource.replace(
    "for index in range(5):\n                try:\n                    batch.add_message(ServiceBusMessage(f\"batch message {index}\"))",
    `message = ServiceBusMessage("reused")
            for index in range(5):
                try:
                    batch.add_message(message)`,
  );
  assert.equal(
    evaluateRule("prompt/queue-batch-send", workspace(reusedMessage)),
    false,
  );
});

test("a size-error handler cannot log and send an underfilled batch", () => {
  const loggedOnly = goldenSource.replace(
    'raise RuntimeError("A batch message did not fit") from None',
    'print("A batch message did not fit")',
  );
  const continued = goldenSource.replace(
    'raise RuntimeError("A batch message did not fit") from None',
    "continue",
  );
  for (const source of [loggedOnly, continued]) {
    assert.equal(
      evaluateRule("prompt/queue-batch-send", workspace(source)),
      false,
    );
  }
});

test("every path that sends a batch has five successful fresh additions", () => {
  const partialBranch = goldenSource.replace(
    "            for index in range(5):",
    "            if should_add:\n                for index in range(5):",
  ).replace(
    "                try:\n                    batch.add_message",
    "                    try:\n                        batch.add_message",
  ).replace(
    "                except MessageSizeExceededError:",
    "                    except MessageSizeExceededError:",
  ).replace(
    '                    raise RuntimeError("A batch message did not fit") from None',
    '                        raise RuntimeError("A batch message did not fit") from None',
  );
  assert.equal(
    evaluateRule("prompt/queue-batch-send", workspace(partialBranch)),
    false,
  );

  const rebuilt = `
import os
from azure.servicebus import ServiceBusClient, ServiceBusMessage
from azure.servicebus.exceptions import MessageSizeExceededError

with ServiceBusClient.from_connection_string(
    os.environ["SERVICE_BUS_CONNECTION_STRING"]
) as client:
    with client.get_queue_sender(
        queue_name=os.environ["SERVICE_BUS_QUEUE_NAME"]
    ) as sender:
        if rebuild:
            current = sender.create_message_batch()
            for index in range(5):
                try:
                    current.add_message(ServiceBusMessage(str(index)))
                except MessageSizeExceededError:
                    raise RuntimeError("abort") from None
            sender.send_messages(current)
        else:
            replacement = sender.create_message_batch()
            for index in range(5):
                try:
                    replacement.add_message(ServiceBusMessage(str(index)))
                except MessageSizeExceededError:
                    raise RuntimeError("abort") from None
            sender.send_messages(replacement)
`;
  assert.equal(
    evaluateRule("prompt/queue-batch-send", workspace(rebuilt)),
    true,
  );
});

test("body output and settlement require the exact received message in order", () => {
  const wrongBody = goldenSource.replace(
    "print(message.body)",
    'print("received")',
  );
  assert.equal(
    evaluateRule("prompt/queue-receive", workspace(wrongBody)),
    false,
  );

  const wrongIdentity = goldenSource.replace(
    "receiver.complete_message(message)",
    "receiver.complete_message(other_message)",
  );
  assert.equal(
    evaluateRule("prompt/message-settlement", workspace(wrongIdentity)),
    false,
  );

  const wrongOrder = goldenSource.replace(
    `                print(message.body)
                receiver.complete_message(message)`,
    `                receiver.complete_message(message)
                print(message.body)`,
  );
  assert.equal(
    evaluateRule("prompt/message-settlement", workspace(wrongOrder)),
    false,
  );
});

test("normal body processing must dominate completion", () => {
  const conditionalOutput = goldenSource.replace(
    "print(message.body)",
    "if should_print:\n                    print(message.body)",
  );
  const finallyCompletion = goldenSource.replace(
    "receiver.complete_message(message)",
    `try:
                    pass
                finally:
                    receiver.complete_message(message)`,
  );
  const catchCompletion = goldenSource.replace(
    "receiver.complete_message(message)",
    `try:
                    raise RuntimeError("processing failed")
                except RuntimeError:
                    receiver.complete_message(message)`,
  );
  for (const source of [
    conditionalOutput,
    finallyCompletion,
    catchCompletion,
  ]) {
    assert.equal(
      evaluateRule("prompt/message-settlement", workspace(source)),
      false,
    );
  }
});

test("mutually exclusive branches cannot assemble message processing", () => {
  const split = goldenSource.replace(
    `                print(message.body)
                receiver.complete_message(message)`,
    `                if should_print:
                    print(message.body)
                else:
                    receiver.complete_message(message)`,
  );
  assert.equal(evaluateRule("prompt/queue-receive", workspace(split)), false);
  assert.equal(
    evaluateRule("prompt/message-settlement", workspace(split)),
    false,
  );
});

test("exclusive settlement branches are valid but a second settlement is not", () => {
  const exclusive = goldenSource.replace(
    `                print(message.body)
                receiver.complete_message(message)`,
    `                if should_retry:
                    receiver.abandon_message(message)
                else:
                    print(message.body)
                    receiver.complete_message(message)`,
  );
  assert.equal(evaluateRule("prompt/queue-receive", workspace(exclusive)), true);
  assert.equal(
    evaluateRule("prompt/message-settlement", workspace(exclusive)),
    true,
  );

  const twice = goldenSource.replace(
    "                receiver.complete_message(message)",
    `                receiver.complete_message(message)
                receiver.dead_letter_message(message)`,
  );
  assert.equal(
    evaluateRule("prompt/message-settlement", workspace(twice)),
    false,
  );
});

test("positional receive overloads retain finite count and wait bounds", () => {
  const positional = goldenSource.replaceAll(
    `receiver.receive_messages(
                max_message_count=5,
                max_wait_time=5,
            )`,
    "receiver.receive_messages(5, 5)",
  );
  assert.equal(evaluateRule("prompt/queue-receive", workspace(positional)), true);
  assert.equal(
    evaluateRule("prompt/topic-subscription", workspace(positional)),
    true,
  );
});

test("collection loops cover every possible received message", () => {
  const breakAfterFirst = goldenSource.replace(
    "receiver.complete_message(message)",
    "receiver.complete_message(message)\n                break",
  );
  assert.equal(
    evaluateRule("prompt/message-settlement", workspace(breakAfterFirst)),
    false,
  );
  const oneMessage = breakAfterFirst.replaceAll(
    "max_message_count=5",
    "max_message_count=1",
  );
  assert.equal(
    evaluateRule("prompt/message-settlement", workspace(oneMessage)),
    true,
  );
});

test("topic send and subscription receive must use the same topic", () => {
  const mismatch = goldenSource.replace(
    `with client.get_subscription_receiver(
            topic_name=topic_name,`,
    `with client.get_subscription_receiver(
            topic_name=os.environ["OTHER_TOPIC_NAME"],`,
  );
  assert.equal(
    evaluateRule("prompt/topic-subscription", workspace(mismatch)),
    false,
  );
});

test("every constructed resource must be cleaned after its last use", () => {
  const leak = goldenSource.replace(
    `        with client.get_topic_sender(topic_name=topic_name) as sender:
            sender.send_messages(ServiceBusMessage("topic message"))`,
    `        sender = client.get_topic_sender(topic_name=topic_name)
        sender.send_messages(ServiceBusMessage("topic message"))`,
  );
  assert.equal(
    evaluateRule("prompt/resource-lifecycle", workspace(leak)),
    false,
  );

  const earlyClose = `
import os
from azure.servicebus import ServiceBusClient, ServiceBusMessage
client = ServiceBusClient.from_connection_string(
    os.environ["SERVICE_BUS_CONNECTION_STRING"]
)
sender = client.get_queue_sender(
    queue_name=os.environ["SERVICE_BUS_QUEUE_NAME"]
)
sender.close()
sender.send_messages(ServiceBusMessage("used after close"))
client.close()
`;
  assert.equal(
    evaluateRule("prompt/resource-lifecycle", workspace(earlyClose)),
    false,
  );
});

test("ExitStack and protected explicit close forms manage exact resources", () => {
  const exitStack = `
import os
from contextlib import ExitStack
from azure.servicebus import ServiceBusClient, ServiceBusMessage

with ExitStack() as stack:
    client = stack.enter_context(
        ServiceBusClient.from_connection_string(
            os.environ["SERVICE_BUS_CONNECTION_STRING"]
        )
    )
    sender = stack.enter_context(
        client.get_queue_sender(
            queue_name=os.environ["SERVICE_BUS_QUEUE_NAME"]
        )
    )
    sender.send_messages(ServiceBusMessage("managed"))
`;
  assert.equal(
    evaluateRule("prompt/resource-lifecycle", workspace(exitStack)),
    true,
  );

  const explicitAsync = `
import asyncio
import os
from azure.servicebus import ServiceBusMessage
from azure.servicebus.aio import ServiceBusClient

async def main():
    client = ServiceBusClient.from_connection_string(
        os.environ["SERVICE_BUS_CONNECTION_STRING"]
    )
    try:
        sender = client.get_queue_sender(
            queue_name=os.environ["SERVICE_BUS_QUEUE_NAME"]
        )
        try:
            await sender.send_messages(ServiceBusMessage("managed"))
        finally:
            await sender.close()
    finally:
        await client.close()

asyncio.run(main())
`;
  assert.equal(
    evaluateRule("prompt/async-client", workspace(explicitAsync)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/resource-lifecycle", workspace(explicitAsync)),
    true,
  );

  const sequential = explicitAsync
    .replace("    try:\n        sender =", "    sender =")
    .replace("        try:\n            await sender.send_messages", "    await sender.send_messages")
    .replace("        finally:\n            await sender.close()", "    await sender.close()")
    .replace("    finally:\n        await client.close()", "    await client.close()");
  assert.equal(
    evaluateRule("prompt/resource-lifecycle", workspace(sequential)),
    false,
  );
});

test("empty, invalid, comment-only, and prose-only source fail all rules", () => {
  for (const source of [
    "",
    "# ServiceBusClient send_messages receive_messages\n",
    '"""ServiceBusClient send_messages receive_messages"""\n',
    "this is not valid Python",
  ]) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace(source)), false, rule);
    }
  }
});
