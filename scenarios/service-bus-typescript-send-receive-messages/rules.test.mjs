import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/service-bus-typescript-rules.mjs";
import {
  activeDependencies,
  loadSourceManifest,
  sourceDocuments,
} from "./tools/source-manifest.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadSourceManifest(goldenPath);

function withSource(source, packageJson = golden.packageJson) {
  const documents = source.trim()
    ? [{ path: "src/service-bus.ts", source }]
    : [];
  return {
    ...golden,
    documents,
    packageJson,
    source,
    sourceFiles: documents.map(({ path }) => path),
  };
}

test.skip("reference has exactly nine passing prompt criteria", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/packages",
    "prompt/environment-client",
    "prompt/queue-single",
    "prompt/queue-batch",
    "prompt/queue-receive",
    "prompt/processor-handlers",
    "prompt/topic-send",
    "prompt/subscription-receive",
    "prompt/client-lifecycle",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
});

test.skip("reference passes reusable TypeScript checks", () => {
  for (const check of typeScriptCheckNames()) {
    assert.equal(evaluateTypeScriptCheck(check, golden), true, check);
  }
});

test.skip("source manifest is deterministic and ignores development dependencies", () => {
  assert.deepEqual(
    sourceDocuments({
      documents: [
        { path: "z.ts", source: "const z = 1;" },
        { path: "a.ts", source: "const a = 1;" },
      ],
    }).map(({ path }) => path),
    ["a.ts", "z.ts"],
  );
  assert.deepEqual(activeDependencies('{"devDependencies":{"fake":"1"}}'), {});
  assert.deepEqual(activeDependencies("{broken"), {});
});

test.skip("every prompt criterion rejects missing generated source", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource("")), false, rule);
  }
});

test.skip("runtime SDK packages are required at runtime", () => {
  for (const packageName of ["@azure/identity", "@azure/service-bus"]) {
    const manifest = JSON.parse(golden.packageJson);
    manifest.devDependencies[packageName] = manifest.dependencies[packageName];
    delete manifest.dependencies[packageName];
    assert.equal(
      evaluateRule(
        "prompt/packages",
        { ...golden, packageJson: JSON.stringify(manifest) },
      ),
      false,
      packageName,
    );
  }
});

test.skip("real aliased and namespace SDK imports retain provenance", () => {
  const aliased = golden.source
    .replace(
      'import { DefaultAzureCredential } from "@azure/identity";',
      'import { DefaultAzureCredential as Credential } from "@azure/identity";',
    )
    .replace(
      /import \{\s*ServiceBusClient,[\s\S]*?\} from "@azure\/service-bus";/,
      'import * as messaging from "@azure/service-bus";\n' +
        'import type { ProcessErrorArgs, ServiceBusReceivedMessage } ' +
        'from "@azure/service-bus";',
    )
    .replaceAll("new DefaultAzureCredential()", "new Credential()")
    .replaceAll("new ServiceBusClient(", "new messaging.ServiceBusClient(")
    .replaceAll(": ServiceBusMessage", ": messaging.ServiceBusMessage");
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource(aliased)), true, rule);
  }
});

test.skip("a separate type-only ServiceBusMessage import is accepted", () => {
  const source = golden.source.replace(
    /  type ServiceBusMessage,\r?\n/,
    "",
  ).replace(
    'from "@azure/service-bus";',
    'from "@azure/service-bus";\n' +
      'import type { ServiceBusMessage } from "@azure/service-bus";',
  );
  assert.equal(evaluateRule("prompt/queue-batch", withSource(source)), true);
  assert.equal(evaluateRule("prompt/topic-send", withSource(source)), true);
});

test.skip("type-only, fake, and shadowed constructors cannot authenticate a client", () => {
  const cases = [
    golden.source.replace(
      'import { DefaultAzureCredential } from "@azure/identity";',
      'import type { DefaultAzureCredential } from "@azure/identity";',
    ),
    golden.source.replace(
      'from "@azure/service-bus";',
      'from "fake-service-bus";',
    ),
    golden.source.replace(
      "async function main(): Promise<void> {",
      "async function main(ServiceBusClient): Promise<void> {",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/environment-client", withSource(source)),
      false,
    );
  }
});

test.skip("the fully qualified namespace and a genuine Entra credential are required", () => {
  const wrongNamespace = golden.source.replace(
    "SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE",
    "SERVICE_BUS_CONNECTION_STRING",
  );
  const wrongCredential = golden.source.replace(
    "new DefaultAzureCredential()",
    "credential",
  );
  assert.equal(
    evaluateRule("prompt/environment-client", withSource(wrongNamespace)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/environment-client", withSource(wrongCredential)),
    false,
  );
});

test.skip("single queue send must be awaited on the queue sender", () => {
  const unawaited = golden.source.replace(
    "await queueSender.sendMessages({",
    "queueSender.sendMessages({",
  );
  const wrongSender = golden.source.replace(
    "await queueSender.sendMessages({",
    "await topicSender.sendMessages({",
  );
  assert.equal(evaluateRule("prompt/queue-single", withSource(unawaited)), false);
  assert.equal(evaluateRule("prompt/queue-single", withSource(wrongSender)), false);
});

test.skip("batch requires exactly five fresh messages and false handling", () => {
  const cases = [
    golden.source.replace("index < 5", "index < 4"),
    golden.source.replace(
      "const message: ServiceBusMessage = {",
      "const message = {",
    ),
    golden.source.replace("if (!batch.tryAddMessage(message))", "if (true)"),
    golden.source.replace(
      "await queueSender.sendMessages(batch);",
      "await queueSender.sendMessages(otherBatch);",
    ),
    golden.source.replace(
      "await queueSender.sendMessages(batch);",
      "queueSender.sendMessages(batch);",
    ),
    golden.source.replace(
      "throw new Error(`Queue batch message ${index} did not fit.`);",
      "console.error(`Queue batch message ${index} did not fit.`);",
    ),
  ];
  for (const source of cases) {
    assert.equal(evaluateRule("prompt/queue-batch", withSource(source)), false);
  }
});

test.skip("five explicit fresh additions are accepted", () => {
  const additions = Array.from(
    { length: 5 },
    (_, index) => `
    const message${index}: ServiceBusMessage = { body: "message-${index}" };
    const added${index} = batch.tryAddMessage(message${index});
    if (!added${index}) throw new Error("batch full");`,
  ).join("\n");
  const source = golden.source.replace(
    /    for \(let index = 0; index < 5; index \+= 1\) \{[\s\S]*?\n    \}\n    await queueSender\.sendMessages\(batch\);/,
    `${additions}\n    await queueSender.sendMessages(batch);`,
  );
  assert.equal(evaluateRule("prompt/queue-batch", withSource(source)), true);
});

test.skip("five explicit additions reject one reused message object", () => {
  const additions = Array.from(
    { length: 5 },
    (_, index) => `
    const added${index} = batch.tryAddMessage(message);
    if (!added${index}) throw new Error("batch full");`,
  ).join("\n");
  const source = golden.source.replace(
    /\s+for \(let index = 0; index < 5; index \+= 1\) \{[\s\S]*?\r?\n\s+\}\r?\n\s+await queueSender\.sendMessages\(batch\);/,
    `      const message: ServiceBusMessage = { body: "reused" };
${additions}
      await queueSender.sendMessages(batch);`,
  );
  assert.equal(evaluateRule("prompt/queue-batch", withSource(source)), false);
});

test.skip("batch validation is path-complete and accepts a fresh rebuild", () => {
  const partial = golden.source.replace(
    /(\s+for \(let index = 0; index < 5; index \+= 1\) \{[\s\S]*?\r?\n\s+\})(\r?\n\s+await queueSender\.sendMessages\(batch\);)/,
    "\n      if (shouldAdd) {$1\n      }$2",
  );
  assert.equal(evaluateRule("prompt/queue-batch", withSource(partial)), false);

  const rebuilt = golden.source.replace(
    "const batch = await queueSender.createMessageBatch();",
    `let batch = await queueSender.createMessageBatch();
      batch = await queueSender.createMessageBatch();`,
  );
  assert.equal(evaluateRule("prompt/queue-batch", withSource(rebuilt)), true);
});

test.skip("a batch cannot be sent before its five successful additions", () => {
  const source = golden.source.replace(
    "    for (let index = 0; index < 5; index += 1) {",
    `    await queueSender.sendMessages(batch);
    for (let index = 0; index < 5; index += 1) {`,
  );
  assert.equal(evaluateRule("prompt/queue-batch", withSource(source)), false);
});

test.skip("queue receive must be bounded, awaited, printed, and settled by identity", () => {
  const cases = [
    golden.source.replace("maxWaitTimeInMs: 5_000", "maxWaitTimeInMs: 0"),
    golden.source.replace(
      "await queueReceiver.receiveMessages(5",
      "queueReceiver.receiveMessages(5",
    ),
    golden.source.replace("console.log(message.body);", 'console.log("message");'),
    golden.source.replace(
      "await queueReceiver.completeMessage(message);",
      "await queueReceiver.completeMessage(otherMessage);",
    ),
    golden.source.replace(
      "await queueReceiver.completeMessage(message);",
      "await subscriptionReceiver.completeMessage(message);",
    ),
  ];
  for (const source of cases) {
    assert.equal(evaluateRule("prompt/queue-receive", withSource(source)), false);
  }
});

test.skip("queue and subscription completion must follow body output", () => {
  const queue = golden.source.replace(
    /\s+console\.log\(message\.body\);\r?\n\s+await queueReceiver\.completeMessage\(message\);/,
    `
        await queueReceiver.completeMessage(message);
        console.log(message.body);`,
  );
  const subscription = golden.source.replace(
    /\s+console\.log\(message\.body\);\r?\n\s+await subscriptionReceiver\.completeMessage\(message\);/,
    `
        await subscriptionReceiver.completeMessage(message);
        console.log(message.body);`,
  );
  assert.equal(evaluateRule("prompt/queue-receive", withSource(queue)), false);
  assert.equal(
    evaluateRule("prompt/subscription-receive", withSource(subscription)),
    false,
  );
});

test.skip("exclusive settlement outcomes pass while double settlement fails", () => {
  const exclusive = golden.source.replace(
    /(\s*)console\.log\(message\.body\);\r?\n\s*await queueReceiver\.completeMessage\(message\);/,
    `$1if (shouldRetry) {
$1  await queueReceiver.abandonMessage(message);
$1} else {
$1  console.log(message.body);
$1  await queueReceiver.completeMessage(message);
$1}`,
  );
  assert.equal(evaluateRule("prompt/queue-receive", withSource(exclusive)), true);

  const twice = golden.source.replace(
    /(\s*)await queueReceiver\.completeMessage\(message\);/,
    `$1await queueReceiver.completeMessage(message);
$1await queueReceiver.deadLetterMessage(message);`,
  );
  assert.equal(evaluateRule("prompt/queue-receive", withSource(twice)), false);
});

test.skip("normal body output must dominate completion", () => {
  const conditionalOutput = golden.source.replace(
    /(\s*)console\.log\(message\.body\);\r?\n\s*await queueReceiver\.completeMessage\(message\);/,
    `$1if (shouldPrint) {
$1  console.log(message.body);
$1}
$1await queueReceiver.completeMessage(message);`,
  );
  const finallyCompletion = golden.source.replace(
    /(\s*)await queueReceiver\.completeMessage\(message\);/,
    `$1try {
$1  // processing
$1} finally {
$1  await queueReceiver.completeMessage(message);
$1}`,
  );
  const catchCompletion = golden.source.replace(
    /(\s*)await queueReceiver\.completeMessage\(message\);/,
    `$1try {
$1  throw new Error("processing failed");
$1} catch {
$1  await queueReceiver.completeMessage(message);
$1}`,
  );
  for (const source of [
    conditionalOutput,
    finallyCompletion,
    catchCompletion,
  ]) {
    assert.equal(evaluateRule("prompt/queue-receive", withSource(source)), false);
  }
});

test.skip("collection loops may break only when the receive max is one", () => {
  const queueBreak = golden.source.replace(
    /(\s*)await queueReceiver\.completeMessage\(message\);/,
    `$1await queueReceiver.completeMessage(message);
$1break;`,
  );
  assert.equal(
    evaluateRule("prompt/queue-receive", withSource(queueBreak)),
    false,
  );

  const subscriptionBreak = golden.source.replace(
    /(\s*)await subscriptionReceiver\.completeMessage\(message\);/,
    `$1await subscriptionReceiver.completeMessage(message);
$1break;`,
  );
  assert.equal(
    evaluateRule("prompt/subscription-receive", withSource(subscriptionBreak)),
    true,
  );
});

test.skip("receive aliases snapshot numeric counts and option values", () => {
  const source = golden.source.replace(
    /const queueMessages = await queueReceiver\.receiveMessages\(5, \{\r?\n      maxWaitTimeInMs: 5_000,\r?\n    \}\);/,
    `let requested = 1;
    const maximum = requested;
    requested = 5;
    let wait = 5_000;
    const capturedWait = wait;
    const receiveOptions = { maxWaitTimeInMs: capturedWait };
    wait = 0;
    const queueMessages = await queueReceiver.receiveMessages(
      maximum, receiveOptions);`,
  ).replace(
    "await queueReceiver.completeMessage(message);",
    `await queueReceiver.completeMessage(message);
      break;`,
  );
  assert.equal(evaluateRule("prompt/queue-receive", withSource(source)), true);
  assert.equal(
    evaluateRule(
      "prompt/queue-receive",
      withSource(source.replace("const maximum = requested;", "let maximum = 1;")
        .replace("requested = 5;", "maximum = 2;")),
    ),
    false,
  );
});

test.skip("unknown receive counts require full collection iteration", () => {
  const source = golden.source.replace(
    "queueReceiver.receiveMessages(5, {",
    `queueReceiver.receiveMessages(
      Number(process.env.SERVICE_BUS_RECEIVE_MAX), {`,
  );
  assert.equal(evaluateRule("prompt/queue-receive", withSource(source)), true);
  assert.equal(
    evaluateRule(
      "prompt/queue-receive",
      withSource(
        source.replace(
          "await queueReceiver.completeMessage(message);",
          `await queueReceiver.completeMessage(message);
      break;`,
        ),
      ),
    ),
    false,
  );
});

test.skip("receive helper defaults yield to explicit count and options arguments", () => {
  const helper = `
async function receiveQueue(
  receiver: ReturnType<ServiceBusClient["createReceiver"]>,
  maximum = 1,
  options = { maxWaitTimeInMs: 5_000 },
): Promise<void> {
  const messages = await receiver.receiveMessages(maximum, options);
  for (const message of messages) {
    console.log(message.body);
    await receiver.completeMessage(message);
    break;
  }
}

`;
  const delegated = helper + golden.source.replace(
    /    const queueMessages = await queueReceiver\.receiveMessages\(5, \{\r?\n      maxWaitTimeInMs: 5_000,\r?\n    \}\);\r?\n    for \(const message of queueMessages\) \{\r?\n      console\.log\(message\.body\);\r?\n      await queueReceiver\.completeMessage\(message\);\r?\n    \}/,
    "    await receiveQueue(queueReceiver);",
  );
  assert.equal(
    evaluateRule("prompt/queue-receive", withSource(delegated)),
    true,
  );
  for (const argumentsList of [
    "queueReceiver, 2, { maxWaitTimeInMs: 5_000 }",
    "queueReceiver, 1, { maxWaitTimeInMs: 0 }",
    "queueReceiver, 101, { maxWaitTimeInMs: 5_000 }",
    "queueReceiver, 0, { maxWaitTimeInMs: 5_000 }",
    "queueReceiver, -1, { maxWaitTimeInMs: 5_000 }",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/queue-receive",
        withSource(
          delegated.replace(
            "receiveQueue(queueReceiver)",
            `receiveQueue(${argumentsList})`,
          ),
        ),
      ),
      false,
      argumentsList,
    );
  }
});

test.skip("receive option aliases retain identity but use current property state", () => {
  const source = golden.source.replace(
    /const queueMessages = await queueReceiver\.receiveMessages\(5, \{\r?\n      maxWaitTimeInMs: 5_000,\r?\n    \}\);/,
    `let receiveOptions = { maxWaitTimeInMs: 0 };
    const optionsAlias = receiveOptions;
    receiveOptions = { maxWaitTimeInMs: 0 };
    optionsAlias.maxWaitTimeInMs = 5_000;
    const queueMessages = await queueReceiver.receiveMessages(
      5, optionsAlias);`,
  );
  assert.equal(evaluateRule("prompt/queue-receive", withSource(source)), true);
  assert.equal(
    evaluateRule(
      "prompt/queue-receive",
      withSource(
        source.replace(
          "optionsAlias.maxWaitTimeInMs = 5_000;",
          "receiveOptions.maxWaitTimeInMs = 5_000;",
        ),
      ),
    ),
    false,
  );
});

test.skip("processor requires both live handlers and same-message settlement", () => {
  const cases = [
    golden.source.replace(/\s+processError,\r?\n/, "\n"),
    golden.source.replace(
      "      await processorReceiver.completeMessage(message);",
      "      await processorReceiver.completeMessage(otherMessage);",
    ),
    golden.source.replace(
      "      console.error(args.error);",
      '      console.error("processor failed");',
    ),
    golden.source.replace(
      /\s+processMessage,\r?\n/,
      "\n      processMessage: unrelatedMessageHandler,\n",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/processor-handlers", withSource(source)),
      false,
    );
  }
});

test.skip("processor settlement requires disabled auto-complete and body-first order", () => {
  const automatic = golden.source.replace(
    "autoCompleteMessages: false",
    "autoCompleteMessages: true",
  );
  const premature = golden.source.replace(
    /\s+console\.log\(message\.body\);\r?\n\s+await processorReceiver\.completeMessage\(message\);/,
    `
        await processorReceiver.completeMessage(message);
        console.log(message.body);`,
  );
  for (const source of [automatic, premature]) {
    assert.equal(
      evaluateRule("prompt/processor-handlers", withSource(source)),
      false,
    );
  }
});

test.skip("subscribe options use current object identity and property state", () => {
  const base = golden.source.replace("} as const;", "};");
  const cases = [
    [
      false,
      base.replace(
        "    processorSubscription = processorReceiver.subscribe({",
        `    const optionsAlias = processorOptions;
    optionsAlias.autoCompleteMessages = true;
    processorSubscription = processorReceiver.subscribe({`,
      ).replace(
        "    }, processorOptions);",
        "    }, optionsAlias);",
      ),
    ],
    [
      true,
      base.replace(
        "      autoCompleteMessages: false,",
        "      autoCompleteMessages: true,",
      ).replace(
        "    processorSubscription = processorReceiver.subscribe({",
        `    const optionsAlias = processorOptions;
    optionsAlias.autoCompleteMessages = false;
    processorSubscription = processorReceiver.subscribe({`,
      ).replace(
        "    }, processorOptions);",
        "    }, optionsAlias);",
      ),
    ],
    [
      true,
      base.replace(
        "    const processorOptions = {",
        "    let processorOptions = {",
      ).replace(
        "    processorSubscription = processorReceiver.subscribe({",
        `    const optionsAlias = processorOptions;
    processorOptions = { autoCompleteMessages: true };
    processorSubscription = processorReceiver.subscribe({`,
      ).replace(
        "    }, processorOptions);",
        "    }, optionsAlias);",
      ),
    ],
  ];
  for (const [expected, source] of cases) {
    assert.equal(
      evaluateRule("prompt/processor-handlers", withSource(source)),
      expected,
    );
  }
});

test.skip("processor subscription must remain active and close before processor", () => {
  const immediate = golden.source.replace(
    /\s+await wait\(5_000\);\r?\n/,
    "\n",
  );
  const reversed = golden.source.replace(
    /      processorSubscription\?\.close\(\),\r?\n    \]\);\r?\n    await Promise\.allSettled\(\[\r?\n      queueSender\?\.close\(\),/,
    `    ]);
    await Promise.allSettled([
      queueSender?.close(),
      processorReceiver?.close(),
      processorSubscription?.close(),`,
  );
  assert.equal(
    evaluateRule("prompt/processor-handlers", withSource(immediate)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/processor-handlers", withSource(reversed)),
    false,
  );
});

test.skip("topic sending uses a distinct topic sender and a real message", () => {
  const wrongEntity = golden.source.replace(
    "topicSender = client.createSender(topicName);",
    "topicSender = client.createSender(queueName);",
  );
  const fakeMessage = golden.source.replace(
    "const topicMessage: ServiceBusMessage = {",
    "const topicMessage = {",
  );
  assert.equal(evaluateRule("prompt/topic-send", withSource(wrongEntity)), false);
  assert.equal(evaluateRule("prompt/topic-send", withSource(fakeMessage)), false);
});

test.skip("subscription receive binds topic and subscription and settles exact messages", () => {
  const cases = [
    golden.source.replace(
      /\s+topicName,\r?\n\s+subscriptionName,/,
      "\n      queueName,\n      subscriptionName,",
    ),
    golden.source.replace(
      /\s+subscriptionName,\r?\n\s+\);/,
      "\n      otherSubscription,\n    );",
    ),
    golden.source.replace(
      "await subscriptionReceiver.completeMessage(message);",
      "await subscriptionReceiver.completeMessage(otherMessage);",
    ),
    golden.source.replace(
      "await subscriptionReceiver.receiveMessages(1",
      "subscriptionReceiver.receiveMessages(1",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/subscription-receive", withSource(source)),
      false,
    );
  }
});

test.skip("cleanup requires finally, every child, awaiting, and client-last ordering", () => {
  const cases = [
    golden.source.replace("  } finally {", "  }\n  {"),
    golden.source.replace(/\s+topicSender\?\.close\(\),\r?\n/, "\n"),
    golden.source.replace(
      "    await client.close();",
      "    client.close();",
    ),
    golden.source.replace(
      "    await client.close();",
      "    await unrelatedClient.close();",
    ),
    golden.source.replace(
      "      processorSubscription?.close(),",
      "      client.close(),\n      processorSubscription?.close(),",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/client-lifecycle", withSource(source)),
      false,
    );
  }
});

test.skip("cleanup rejects early closes and leaked secondary clients", () => {
  const earlySender = golden.source.replace(
    "    await queueSender.sendMessages({",
    "    await queueSender.close();\n    await queueSender.sendMessages({",
  );
  const leakedClient = golden.source.replace(
    "    queueSender = client.createSender(queueName);",
    `  const secondaryClient = new ServiceBusClient(
    namespace,
    new DefaultAzureCredential(),
  );
    queueSender = client.createSender(queueName);`,
  );
  for (const source of [earlySender, leakedClient]) {
    assert.equal(
      evaluateRule("prompt/client-lifecycle", withSource(source)),
      false,
    );
  }
});

test.skip("cleanup attempts must be independent rather than sequential", () => {
  const sequential = golden.source.replace(
    /    await Promise\.allSettled\(\[\r?\n      queueSender\?\.[\s\S]*?    \]\);/,
    `    await queueSender?.close();
    await queueReceiver?.close();
    await processorReceiver?.close();
    await topicSender?.close();
    await subscriptionReceiver?.close();`,
  );
  assert.equal(
    evaluateRule("prompt/client-lifecycle", withSource(sequential)),
    false,
  );
});

test.skip("child construction is staged inside its cleanup try", () => {
  const source = golden.source
    .replace(/  try \{\r?\n    queueSender =/, "  queueSender =")
    .replace(
      /      subscriptionName,\r?\n    \);\r?\n    await queueSender\.sendMessages\(\{/,
      `      subscriptionName,
    );
  try {
    await queueSender.sendMessages({`,
    );
  assert.equal(
    evaluateRule("prompt/client-lifecycle", withSource(source)),
    false,
  );
});

test.skip("comments, strings, and unreachable false branches are decoys", () => {
  const source = `
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient, type ServiceBusMessage } from "@azure/service-bus";
const documentation = \`
  const client = new ServiceBusClient(namespace, credential);
  await sender.sendMessages(batch);
\`;
if (false) {
  const client = new ServiceBusClient(
    process.env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE,
    new DefaultAzureCredential(),
  );
  const sender = client.createSender(process.env.SERVICE_BUS_QUEUE_NAME);
  const message: ServiceBusMessage = { body: "decoy" };
  await sender.sendMessages(message);
}
`;
  for (const rule of ruleNames().slice(1)) {
    assert.equal(evaluateRule(rule, withSource(source)), false, rule);
  }
});

test.skip("module order cannot change deterministic results", () => {
  const documents = [
    { path: "src/app.ts", source: golden.source },
    {
      path: "src/unused.ts",
      source: "export function decoy() { return false; }",
    },
  ];
  for (const ordered of [documents, [...documents].reverse()]) {
    const workspace = {
      ...golden,
      documents: ordered,
      source: ordered.map(({ source }) => source).join("\n"),
      sourceFiles: ordered.map(({ path }) => path),
    };
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace), true, rule);
    }
  }
});

test.skip("reachable class and object workflows are accepted", () => {
  const main = /async function main\(\): Promise<void> \{([\s\S]*)\r?\n\}\r?\n\r?\nawait main\(\);/.exec(
    golden.source,
  );
  assert.ok(main);
  const prefix = golden.source.slice(0, main.index);
  const workflows = [
    `${prefix}
class Workflow {
  async run(): Promise<void> {${main[1]}
  }
}
const workflow = new Workflow();
await workflow.run();`,
    `${prefix}
const workflow = {
  async run(): Promise<void> {${main[1]}
  },
};
await workflow.run();`,
  ];
  for (const source of workflows) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, withSource(source)), true, rule);
    }
  }
});

test.skip("module graph resolves an imported reachable helper", () => {
  const main = /async function main\(\): Promise<void> \{([\s\S]*)\r?\n\}\r?\n\r?\nawait main\(\);/.exec(
    golden.source,
  );
  assert.ok(main);
  const mainStart = main.index;
  const resourcesStart = main[1].indexOf("  try {");
  const importsAndHelpers = golden.source.slice(0, mainStart);
  const worker = `${importsAndHelpers}
export async function run(
  client,
  queueName,
  topicName,
  subscriptionName,
): Promise<void> {
${main[1].slice(resourcesStart)}
}`;
  const app = `
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { run } from "./worker.js";
const client = new ServiceBusClient(
  process.env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE!,
  new DefaultAzureCredential(),
);
await run(
  client,
  process.env.SERVICE_BUS_QUEUE_NAME!,
  process.env.SERVICE_BUS_TOPIC_NAME!,
  process.env.SERVICE_BUS_SUBSCRIPTION_NAME!,
);`;
  const documents = [
    { path: "src/app.ts", source: app },
    { path: "src/worker.ts", source: worker },
  ];
  const workspace = {
    ...golden,
    documents,
    source: documents.map(({ source }) => source).join("\n"),
    sourceFiles: documents.map(({ path }) => path),
  };
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test.skip("finally may delegate independent cleanup to an awaited helper", () => {
  const cleanup = `    await closeAll(
      processorSubscription,
      queueSender,
      queueReceiver,
      processorReceiver,
      topicSender,
      subscriptionReceiver,
    );`;
  const source = golden.source.replace(
    /    await Promise\.allSettled\(\[\r?\n      processorSubscription\?\.close\(\),\r?\n    \]\);\r?\n    await Promise\.allSettled\(\[[\s\S]*?    \]\);/,
    cleanup,
  ).replace(
    /\r?\nawait main\(\);/,
    `
async function closeAll(
  subscription,
  queueSender,
  queueReceiver,
  processorReceiver,
  topicSender,
  subscriptionReceiver,
): Promise<void> {
  await Promise.allSettled([
    subscription?.close(),
    queueSender.close(),
    queueReceiver.close(),
    processorReceiver.close(),
    topicSender.close(),
    subscriptionReceiver.close(),
  ]);
}

await main();`,
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withSource(source)), true, rule);
  }
});
