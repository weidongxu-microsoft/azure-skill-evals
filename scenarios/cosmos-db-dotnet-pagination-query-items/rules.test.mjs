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
} from "./tools/cosmos-dotnet-pagination-rules.mjs";

const goldenRoot = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadWorkspace(goldenRoot);
const sharedWorkspace = loadDotnetWorkspace(goldenRoot);
const baselineRoot = fileURLToPath(
  new URL("./fixtures/baseline-33374429826", import.meta.url),
);
const baseline33374429826 = loadWorkspace(baselineRoot);
const baselineShared33374429826 = loadDotnetWorkspace(baselineRoot);

function workspace(source, project = completeWorkspace.project) {
  return {
    ...completeWorkspace,
    projects: undefined,
    project,
    source,
    sourceFiles: ["Program.cs"],
  };
}

test("golden passes six prompt rules and every shared .NET check", () => {
  assert.equal(ruleNames().length, 6);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(evaluateDotnetCheck(check, sharedWorkspace), true, check);
  }
});

test("baseline run 33374429826 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
  for (const check of dotnetCheckNames()) {
    assert.equal(
      evaluateDotnetCheck(check, baselineShared33374429826),
      true,
      check,
    );
  }
});

test("focused golden omissions fail their own criteria", () => {
  const cases = [
    [
      "prompt/cosmos-manifest",
      completeWorkspace.source,
      completeWorkspace.project.replace("3.62.1", "3.61.0"),
    ],
    [
      "prompt/cosmos-manifest",
      completeWorkspace.source,
      completeWorkspace.project.replace("13.0.4", "13.0.3"),
    ],
    [
      "prompt/category-query",
      completeWorkspace.source.replace('"electronics"', '"furniture"'),
      completeWorkspace.project,
    ],
    [
      "prompt/page-size",
      completeWorkspace.source.replace("MaxItemCount = 50", "MaxItemCount = 49"),
      completeWorkspace.project,
    ],
    [
      "prompt/feed-pagination",
      completeWorkspace.source.replace(
        "iterator.HasMoreResults",
        "otherIterator.HasMoreResults",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/continuation-resume",
      completeWorkspace.source.replace(
        "continuationToken: resumeToken",
        "continuationToken: null",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/continuation-resume",
      completeWorkspace.source.replace(
        "latestToken = page.ContinuationToken;",
        "latestToken = null;",
      ),
      completeWorkspace.project,
    ],
    [
      "prompt/request-charge-total",
      completeWorkspace.source.replace(
        "page.RequestCharge",
        "page.Count",
      ),
      completeWorkspace.project,
    ],
  ];

  for (const [rule, source, project] of cases) {
    assert.equal(evaluateRule(rule, workspace(source, project)), false, rule);
  }
});

test("aliases, named arguments, literal queries, and reachable helpers pass", () => {
  const source = `
using Cosmos = Microsoft.Azure.Cosmos;

string? checkpoint =
    Environment.GetEnvironmentVariable("COSMOS_CONTINUATION_TOKEN");
using var client = new Cosmos.CosmosClient("connection");
Cosmos.Container target = client.GetContainer("db", "items");
await QueryAsync(target, checkpoint);

static async Task QueryAsync(
    Cosmos.Container container,
    string? savedToken)
{
    Cosmos.QueryDefinition query = new(
        "SELECT * FROM item WHERE item.category = 'electronics'");
    var options = new Cosmos.QueryRequestOptions();
    options.MaxItemCount = 50;
    using var feed = container.GetItemQueryIterator<Item>(
        requestOptions: options,
        continuationToken: savedToken,
        queryDefinition: query);
    double total = 0D;
    while (feed.HasMoreResults)
    {
        var response = await feed.ReadNextAsync();
        var next = response.ContinuationToken;
        PrintToken(next);
        var charge = response.RequestCharge;
        total = charge + total;
    }
    Console.Out.WriteLine(total);
}

static void PrintToken(string? token)
{
    Console.WriteLine(token);
}

sealed class Item {}
`;

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace(source)), true, rule);
  }
});

test("separately applied query parameters are accepted", () => {
  const source = completeWorkspace.source.replace(
    `var query = new QueryDefinition(
    "SELECT * FROM c WHERE c.category = @category")
    .WithParameter("@category", "electronics");`,
    `var query = new QueryDefinition(
    "SELECT * FROM c WHERE c.category = @kind");
query.WithParameter("@kind", "electronics");`,
  );

  assert.equal(evaluateRule("prompt/category-query", workspace(source)), true);
  assert.equal(evaluateRule("prompt/feed-pagination", workspace(source)), true);
});

test("continuation tokens returned by reachable argument parsers are accepted", () => {
  const source = completeWorkspace.source.replace(
    `string? resumeToken =
    Environment.GetEnvironmentVariable("COSMOS_CONTINUATION_TOKEN");`,
    `string? resumeToken = ParseContinuationToken(args);

static string? ParseContinuationToken(string[] arguments)
{
    if (arguments.Length == 0)
    {
        return null;
    }
    return arguments[0];
}`,
  );

  assert.equal(
    evaluateRule("prompt/continuation-resume", workspace(source)),
    true,
  );
});

test("hard-coded and disconnected helper tokens remain rejected", () => {
  const variants = [
    completeWorkspace.source.replace(
      "string? resumeToken = args.Length > 0 ? args[0] : null;",
      `string? resumeToken = ParseContinuationToken(args);
static string? ParseContinuationToken(string[] arguments) => "fixed-token";`,
    ),
    completeWorkspace.source.replace(
      "string? resumeToken = args.Length > 0 ? args[0] : null;",
      `string[] unrelated = ["fixed-token"];
string? resumeToken = ParseContinuationToken(unrelated);
static string? ParseContinuationToken(string[] arguments) => arguments[0];`,
    ),
  ];

  for (const source of variants) {
    assert.equal(
      evaluateRule("prompt/continuation-resume", workspace(source)),
      false,
    );
  }
});

test("comments, strings, fake SDK types, and unreachable helpers fail", () => {
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
class CosmosClient : IDisposable
{
    public CosmosClient(string value) {}
    public Container GetContainer(string database, string container) => new();
    public void Dispose() {}
}
class Container
{
    public FeedIterator<Item> GetItemQueryIterator<Item>(
        QueryDefinition query,
        string continuationToken,
        QueryRequestOptions requestOptions) => new();
}
class FeedIterator<T> : IDisposable
{
    public bool HasMoreResults => true;
    public Task<FeedResponse<T>> ReadNextAsync() => throw new Exception();
    public void Dispose() {}
}
class FeedResponse<T>
{
    public string ContinuationToken => "fake";
    public double RequestCharge => 1;
}
class QueryDefinition
{
    public QueryDefinition(string query) {}
    public QueryDefinition WithParameter(string name, string value) => this;
}
class QueryRequestOptions { public int MaxItemCount { get; set; } }
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

test("page size, continuation, and charge must use the paged iterator path", () => {
  const wrongOptions = completeWorkspace.source.replace(
    "requestOptions: requestOptions",
    "requestOptions: new QueryRequestOptions { MaxItemCount = 10 }",
  );
  assert.equal(evaluateRule("prompt/page-size", workspace(wrongOptions)), false);

  const wrongContinuation = completeWorkspace.source.replace(
    "latestToken = page.ContinuationToken;",
    "latestToken = otherPage.ContinuationToken;",
  );
  assert.equal(
    evaluateRule("prompt/continuation-resume", workspace(wrongContinuation)),
    false,
  );

  const wrongCharge = completeWorkspace.source.replace(
    "totalRequestCharge += page.RequestCharge;",
    "totalRequestCharge += otherPage.RequestCharge;",
  );
  assert.equal(
    evaluateRule("prompt/request-charge-total", workspace(wrongCharge)),
    false,
  );
});

test("valid query and pagination cannot be assembled from incompatible paths", () => {
  const source = completeWorkspace.source
    .replace(
      "queryDefinition: query,",
      `queryDefinition: new QueryDefinition(
                "SELECT * FROM c WHERE c.category = 'furniture'"),`,
    )
    .replace(
      "PaginationResult result = await ReadPagesAsync(",
      `using var unused = container.GetItemQueryIterator<CatalogItem>(
    query, null, requestOptions);
PaginationResult result = await ReadPagesAsync(`,
    );

  assert.equal(evaluateRule("prompt/category-query", workspace(source)), true);
  assert.equal(evaluateRule("prompt/feed-pagination", workspace(source)), false);
  assert.equal(
    evaluateRule("prompt/continuation-resume", workspace(source)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/request-charge-total", workspace(source)),
    false,
  );
});
