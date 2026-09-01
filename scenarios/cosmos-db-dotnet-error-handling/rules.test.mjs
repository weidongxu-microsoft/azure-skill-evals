import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  dotnetCheckNames,
  evaluateDotnetCheck,
  loadDotnetWorkspace,
} from "../../languages/dotnet/checks.mjs";
import {
  evaluateRule,
  loadWorkspace,
  ruleNames,
} from "./tools/cosmos-dotnet-error-handling-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadWorkspace(goldenRoot);
const sharedWorkspace = loadDotnetWorkspace(goldenRoot);

function workspace(source, project = completeWorkspace.project) {
  return {
    ...completeWorkspace,
    projects: undefined,
    project,
    source,
    sourceFiles: ["Program.cs"],
  };
}

const manifest = completeWorkspace.project;

test.skip("golden passes seven prompt rules and every shared .NET check", () => {
  assert.equal(ruleNames().length, 7);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, sharedWorkspace), true, check);
  }
});

test.skip("focused golden omissions fail their own criteria", () => {
  const cases = [
    [
      "prompt/cosmos-manifest",
      completeWorkspace.source,
      manifest.replace("3.62.1", "3.61.0"),
    ],
    [
      "prompt/client-retry-options",
      completeWorkspace.source.replace(
        "MaxRetryAttemptsOnRateLimitedRequests = 3",
        "ApplicationName = \"sample\"",
      ),
      manifest,
    ],
    [
      "prompt/cosmos-operation",
      completeWorkspace.source.replace("ReadItemAsync", "FetchItemAsync"),
      manifest,
    ],
    [
      "prompt/exception-details",
      completeWorkspace.source.replace(
        "exception.SubStatusCode",
        "exception.Message",
      ),
      manifest,
    ],
    [
      "prompt/throttling-retry",
      completeWorkspace.source.replace(
        "await Task.Delay(delay);",
        "Console.WriteLine(delay);",
      ),
      manifest,
    ],
    [
      "prompt/not-found-conflict",
      completeWorkspace.source.replace(
        "HttpStatusCode.Conflict",
        "HttpStatusCode.Unauthorized",
      ),
      manifest,
    ],
    [
      "prompt/request-charge",
      completeWorkspace.source.replace(
        "response.RequestCharge",
        "response.ActivityId",
      ),
      manifest,
    ],
  ];

  for (const [rule, source, project] of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test.skip("qualified aliases, filtered catches, and reachable helpers pass", () => {
  const source = `
using System.Net;
using Cosmos = Microsoft.Azure.Cosmos;
using Failure = Microsoft.Azure.Cosmos.CosmosException;

var options = new Cosmos.CosmosClientOptions();
options.MaxRetryAttemptsOnRateLimitedRequests = 2;
using var client = new Cosmos.CosmosClient("connection", options);
Cosmos.Container container = client.GetContainer("db", "items");
await ExecuteAsync(container);

static async Task ExecuteAsync(Cosmos.Container target)
{
    for (int attempt = 0; attempt < 4; attempt++)
    {
        try
        {
            var result = await target.UpsertItemAsync(
                new { id = "1", category = "demo" },
                new Cosmos.PartitionKey("demo"));
            double charge = result.RequestCharge;
            Console.WriteLine(charge);
            return;
        }
        catch (Failure error)
            when (error.StatusCode == HttpStatusCode.TooManyRequests)
        {
            Console.Error.WriteLine(
                $"{error.StatusCode} {error.SubStatusCode} "
                + $"{error.RetryAfter} {error.Diagnostics}");
            await Task.Delay(
                error.RetryAfter ?? TimeSpan.FromMilliseconds(100));
            continue;
        }
        catch (Failure error)
            when (error.StatusCode == HttpStatusCode.NotFound)
        {
            Console.Error.WriteLine(error.StatusCode);
            return;
        }
        catch (Failure error)
            when (error.StatusCode == HttpStatusCode.Conflict)
        {
            Console.Error.WriteLine(error.StatusCode);
            return;
        }
    }
}`;

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test.skip("comments, strings, fake SDK types, and unreachable helpers fail", () => {
  const decoys = [
    `
using Microsoft.Azure.Cosmos;
Console.WriteLine("started");
string sample = """
${completeWorkspace.source}
""";
/* ${completeWorkspace.source} */
`,
    `
class CosmosClientOptions
{
    public int MaxRetryAttemptsOnRateLimitedRequests { get; set; }
}
class CosmosClient : IDisposable
{
    public CosmosClient(string value, CosmosClientOptions options) {}
    public Container GetContainer(string database, string container) => new();
    public void Dispose() {}
}
class Container
{
    public Task<ItemResponse> ReadItemAsync(string id) =>
        Task.FromResult(new ItemResponse());
}
class ItemResponse { public double RequestCharge => 1; }
class CosmosException : Exception
{
    public HttpStatusCode StatusCode => HttpStatusCode.Conflict;
    public int SubStatusCode => 0;
    public TimeSpan RetryAfter => TimeSpan.Zero;
    public object Diagnostics => new();
}
${completeWorkspace.source}
`,
    `
using Microsoft.Azure.Cosmos;
Console.WriteLine("started");
static async Task UnusedAsync()
{
${completeWorkspace.source}
}
`,
  ];

  decoys.forEach((source, index) => {
    for (const rule of ruleNames().filter(
      (name) => name !== "prompt/cosmos-manifest",
    )) {
      assert.equal(
        evaluateRule(rule, workspace(source)),
        false,
        `${index}:${rule}`,
      );
    }
  });
});

test.skip("error handling must protect an operation from the configured client", () => {
  const source = completeWorkspace.source.replace(
    "Container container = client.GetContainer(databaseName, containerName);",
    `Container container = client.GetContainer(databaseName, containerName);
using var otherClient = new CosmosClient("other");
Container other = otherClient.GetContainer("other", "items");`,
  ).replace(
    "await container.ReadItemAsync<InventoryItem>",
    "await other.ReadItemAsync<InventoryItem>",
  );

  for (const rule of [
    "prompt/cosmos-operation",
    "prompt/exception-details",
    "prompt/throttling-retry",
    "prompt/not-found-conflict",
    "prompt/request-charge",
  ]) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test.skip("status handling from incompatible try paths cannot be combined", () => {
  const source = `
using System.Net;
using Microsoft.Azure.Cosmos;
var options = new CosmosClientOptions
{
    MaxRetryAttemptsOnRateLimitedRequests = 2,
};
using var client = new CosmosClient("connection", options);
var container = client.GetContainer("db", "items");
for (int attempt = 0; attempt < 3; attempt++)
{
    try
    {
        var response = await container.ReadItemAsync<object>(
            "id", new PartitionKey("pk"));
        Console.WriteLine(response.RequestCharge);
    }
    catch (CosmosException error)
        when (error.StatusCode == HttpStatusCode.TooManyRequests)
    {
        Console.WriteLine(
            $"{error.StatusCode} {error.SubStatusCode} "
            + $"{error.RetryAfter} {error.Diagnostics}");
        await Task.Delay(
            error.RetryAfter ?? TimeSpan.FromMilliseconds(100));
        continue;
    }
}
try
{
    await container.DeleteItemAsync<object>("id", new PartitionKey("pk"));
}
catch (CosmosException error)
    when (error.StatusCode == HttpStatusCode.NotFound)
{
    Console.WriteLine(error.StatusCode);
}
catch (CosmosException error)
    when (error.StatusCode == HttpStatusCode.Conflict)
{
    Console.WriteLine(error.StatusCode);
}`;

  assert.equal(
    evaluateRule("prompt/not-found-conflict", workspace(source)),
    true,
  );
  assert.equal(
    evaluateRule("prompt/throttling-retry", workspace(source)),
    true,
  );

  const split = source.replace(
    `catch (CosmosException error)
    when (error.StatusCode == HttpStatusCode.Conflict)
{
    Console.WriteLine(error.StatusCode);
}`,
    "",
  ).replace(
    "HttpStatusCode.TooManyRequests",
    "HttpStatusCode.Conflict",
  );
  assert.equal(
    evaluateRule("prompt/not-found-conflict", workspace(split)),
    false,
  );
});

test.skip("unbounded loops and disconnected response charges fail", () => {
  const unbounded = completeWorkspace.source
    .replace(
      "for (int attempt = 1; attempt <= maxAttempts; attempt++)",
      "while (true)",
    )
    .replace("when attempt < maxAttempts", "");
  assert.equal(
    evaluateRule("prompt/throttling-retry", workspace(unbounded)),
    false,
  );

  const disconnectedCharge = completeWorkspace.source.replace(
    "response.RequestCharge",
    "otherResponse.RequestCharge",
  );
  assert.equal(
    evaluateRule("prompt/request-charge", workspace(disconnectedCharge)),
    false,
  );
});
