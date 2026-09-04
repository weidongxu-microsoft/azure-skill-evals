using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Azure;
using Azure.Core;
using Azure.Identity;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.TestHost;
using Xunit;

namespace Contoso.SupportAssistant.Tests;

public sealed class SupportAssistantTests
{
    private static readonly FoundryResources Resources =
        new("vector-store-1", ["file-1"], "support-agent", "1");

    [Fact]
    public async Task CreatesAndInvokesManagedPromptAgent()
    {
        ManagedAgentHandler handler = new();
        using HttpClient client = new(handler);
        FoundryRestGateway gateway = new(
            new Uri("https://example.test/api/projects/support"),
            new StaticCredential(),
            client,
            "answer-model",
            "evaluation-model",
            "https://ai.azure.com/.default");
        string document = Path.GetTempFileName();
        await File.WriteAllTextAsync(
            document,
            "Reset instructions.",
            TestContext.Current.CancellationToken);

        try
        {
            FoundryResources resources = await gateway.IngestAsync(
                [document],
                TestContext.Current.CancellationToken);
            GatewayAnswer answer = await gateway.AskAsync(
                resources,
                "conversation-1",
                "How do I reset it?",
                TestContext.Current.CancellationToken);

            Assert.Equal("support-agent", resources.AgentName);
            Assert.Equal("1", resources.AgentVersion);
            Assert.True(handler.IngestionCompletedBeforeAgentCreation);
            JsonObject definition =
                handler.AgentRequest!["definition"]!.AsObject();
            Assert.Equal("prompt", definition["kind"]!.GetValue<string>());
            Assert.Equal(
                "answer-model", definition["model"]!.GetValue<string>());
            Assert.Equal(
                "file_search",
                definition["tools"]![0]!["type"]!.GetValue<string>());
            JsonObject reference =
                handler.ResponseRequest!["agent_reference"]!.AsObject();
            Assert.Equal(
                "support-agent", reference["name"]!.GetValue<string>());
            Assert.Equal("1", reference["version"]!.GetValue<string>());
            Assert.Null(handler.ResponseRequest["instructions"]);
            Assert.Null(handler.ResponseRequest["tools"]);
            Assert.Equal("response-1", answer.ResponseId);
        }
        finally
        {
            File.Delete(document);
        }
    }

    [Fact]
    public async Task IsolatesEmployeesAndReusesFollowUpConversation()
    {
        FakeGateway gateway = new();
        SupportAssistantService assistant =
            new(gateway, new MemoryStateStore());
        await assistant.IngestAsync(["manual.md"], TestContext.Current.CancellationToken);

        await assistant.AskAsync(
            "employee-a", "shared", "First", TestContext.Current.CancellationToken);
        await assistant.AskAsync(
            "employee-b", "shared", "Second", TestContext.Current.CancellationToken);
        await assistant.AskAsync(
            "employee-a", "shared", "Follow-up", TestContext.Current.CancellationToken);

        Assert.Equal(
            [null, null, "conversation-1"],
            gateway.SeenConversationIds);
    }

    [Fact]
    public async Task RejectsUnknownAndMismatchedFeedback()
    {
        FakeGateway gateway = new();
        SupportAssistantService assistant =
            new(gateway, new MemoryStateStore());
        await assistant.IngestAsync(["manual.md"], TestContext.Current.CancellationToken);
        SupportAnswer answer = await assistant.AskAsync(
            "employee-a", "chat-1", "Reset?", TestContext.Current.CancellationToken);

        await Assert.ThrowsAsync<SupportAssistantException>(() =>
            assistant.RecordFeedbackAsync(
                "employee-a",
                "chat-1",
                "missing",
                "negative",
                null,
                TestContext.Current.CancellationToken));
        await Assert.ThrowsAsync<SupportAssistantException>(() =>
            assistant.RecordFeedbackAsync(
                "employee-b",
                "chat-1",
                answer.ResponseId,
                "negative",
                null,
                TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task EvaluationUsesRetrievedServiceContext()
    {
        FakeGateway gateway = new();
        SupportAssistantService assistant =
            new(gateway, new MemoryStateStore());
        await assistant.IngestAsync(["manual.md"], TestContext.Current.CancellationToken);

        IReadOnlyList<EvaluationMetric> metrics =
            await assistant.EvaluateAsync(
                [new EvaluationCase("reset", "How?", "Hold reset.")],
                TestContext.Current.CancellationToken);

        Assert.Equal("groundedness", metrics[0].Name);
        Assert.Equal(
            "Retrieved reset instructions.",
            gateway.EvaluationRows[0]["context"]!.GetValue<string>());
        Assert.Equal(["conversation-1"], gateway.DeletedConversations);
    }

    [Fact]
    public async Task CompensatesWhenAtomicDurableWriteFails()
    {
        FakeGateway gateway = new();
        MemoryStateStore store = new();
        SupportAssistantService assistant = new(gateway, store);
        await assistant.IngestAsync(["manual.md"], TestContext.Current.CancellationToken);
        store.FailOnSave = 2;

        await Assert.ThrowsAsync<IOException>(() => assistant.AskAsync(
            "employee-a", "chat-1", "Reset?", TestContext.Current.CancellationToken));

        Assert.Equal(["conversation-1"], gateway.DeletedConversations);
    }

    [Fact]
    public async Task HttpRoutesEnforceIdentityAndAdministratorRole()
    {
        FakeGateway gateway = new();
        SupportAssistantService assistant =
            new(gateway, new MemoryStateStore());
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        WebApplication app = builder.Build();
        SupportApi.Map(
            app,
            assistant,
            new ApiOptions(
                true,
                new HashSet<string> { "admin" },
                ["manual.md"],
                EvaluationDatasetPath()));
        await app.StartAsync(TestContext.Current.CancellationToken);
        using HttpClient client = app.GetTestClient();

        try
        {
            client.DefaultRequestHeaders.Add(
                "X-MS-CLIENT-PRINCIPAL-ID", "admin");
            HttpResponseMessage ingest = await client.PostAsJsonAsync(
                "/admin/ingest",
                new { },
                TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.Created, ingest.StatusCode);

            client.DefaultRequestHeaders.Remove(
                "X-MS-CLIENT-PRINCIPAL-ID");
            client.DefaultRequestHeaders.Add(
                "X-MS-CLIENT-PRINCIPAL-ID", "employee-a");
            HttpResponseMessage first = await client.PostAsJsonAsync(
                "/conversations/shared/messages",
                new { question = "First" },
                TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);

            client.DefaultRequestHeaders.Remove(
                "X-MS-CLIENT-PRINCIPAL-ID");
            client.DefaultRequestHeaders.Add(
                "X-MS-CLIENT-PRINCIPAL-ID", "employee-b");
            await client.PostAsJsonAsync(
                "/conversations/shared/messages",
                new { question = "Second" },
                TestContext.Current.CancellationToken);

            client.DefaultRequestHeaders.Remove(
                "X-MS-CLIENT-PRINCIPAL-ID");
            client.DefaultRequestHeaders.Add(
                "X-MS-CLIENT-PRINCIPAL-ID", "employee-a");
            await client.PostAsJsonAsync(
                "/conversations/shared/messages",
                new { question = "Follow-up" },
                TestContext.Current.CancellationToken);

            Assert.Equal(
                [null, null, "conversation-1"],
                gateway.SeenConversationIds);
            HttpResponseMessage forbidden = await client.GetAsync(
                "/admin/unresolved",
                TestContext.Current.CancellationToken);
            Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
        }
        finally
        {
            await app.StopAsync(TestContext.Current.CancellationToken);
            await app.DisposeAsync();
        }
    }

    [Fact]
    public async Task DeletesNewConversationWhenBaselineTransportFails()
    {
        BaselineFailureHandler handler = new();
        using HttpClient client = new(handler);
        FoundryRestGateway gateway = new(
            new Uri("https://example.test/api/projects/support"),
            new StaticCredential(),
            client,
            "answer-model",
            "evaluation-model",
            "https://ai.azure.com/.default");

        await Assert.ThrowsAsync<HttpRequestException>(() =>
            gateway.AskAsync(
                Resources,
                null,
                "Reset?",
                TestContext.Current.CancellationToken));

        Assert.True(handler.DeletedConversation);
    }

    [Fact]
    public async Task EvaluationCleanupUsesNonCancelledToken()
    {
        FakeGateway gateway = new()
        {
            EvaluationFailure = new OperationCanceledException(
                "evaluation cancelled")
        };
        SupportAssistantService assistant =
            new(gateway, new MemoryStateStore());
        await assistant.IngestAsync(
            ["manual.md"], TestContext.Current.CancellationToken);

        await Assert.ThrowsAsync<OperationCanceledException>(() =>
            assistant.EvaluateAsync(
                [new EvaluationCase("reset", "How?", "Hold reset.")],
                TestContext.Current.CancellationToken));

        Assert.Single(gateway.DeleteTokens);
        Assert.False(gateway.DeleteTokens[0].CanBeCanceled);
    }

    [Fact]
    public async Task PreservesEvaluationAndCleanupFailures()
    {
        FakeGateway gateway = new()
        {
            EvaluationFailure = new TimeoutException("evaluation timed out"),
            DeleteFailure = new HttpRequestException(
                "cleanup connection failed")
        };
        SupportAssistantService assistant =
            new(gateway, new MemoryStateStore());
        await assistant.IngestAsync(
            ["manual.md"], TestContext.Current.CancellationToken);

        AggregateException error =
            await Assert.ThrowsAsync<AggregateException>(() =>
                assistant.EvaluateAsync(
                    [new EvaluationCase("reset", "How?", "Hold reset.")],
                    TestContext.Current.CancellationToken));

        Assert.Equal(2, error.InnerExceptions.Count);
        Assert.Single(gateway.DeleteTokens);
        Assert.False(gateway.DeleteTokens[0].CanBeCanceled);
    }

    [Fact]
    public async Task BackgroundAuthenticationFailureReachesFailedState()
    {
        FakeGateway gateway = new()
        {
            EvaluationFailure = new AuthenticationFailedException(
                "credential rejected")
        };
        SupportAssistantService assistant =
            new(gateway, new MemoryStateStore());
        await assistant.IngestAsync(
            ["manual.md"], TestContext.Current.CancellationToken);
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        WebApplication app = builder.Build();
        SupportApi.Map(
            app,
            assistant,
            new ApiOptions(
                true,
                new HashSet<string> { "admin" },
                ["manual.md"],
                EvaluationDatasetPath()));
        await app.StartAsync(TestContext.Current.CancellationToken);
        using HttpClient client = app.GetTestClient();
        client.DefaultRequestHeaders.Add(
            "X-MS-CLIENT-PRINCIPAL-ID", "admin");

        try
        {
            HttpResponseMessage response = await client.PostAsJsonAsync(
                "/admin/evaluations",
                new { },
                TestContext.Current.CancellationToken);
            JsonObject accepted = JsonNode.Parse(
                await response.Content.ReadAsStringAsync(
                    TestContext.Current.CancellationToken))!.AsObject();
            string operationId =
                accepted["operationId"]!.GetValue<string>();
            string status = "running";
            for (int attempt = 0;
                 attempt < 100 && status == "running";
                 attempt++)
            {
                await Task.Delay(
                    TimeSpan.FromMilliseconds(10),
                    TestContext.Current.CancellationToken);
                JsonObject operation = JsonNode.Parse(
                    await client.GetStringAsync(
                        $"/admin/operations/{operationId}",
                        TestContext.Current.CancellationToken))!.AsObject();
                status = operation["status"]!.GetValue<string>();
            }

            Assert.Equal("failed", status);
        }
        finally
        {
            await app.StopAsync(TestContext.Current.CancellationToken);
            await app.DisposeAsync();
        }
    }

    [Fact]
    public async Task PreIngestionEvaluationReachesFailedState()
    {
        SupportAssistantService assistant =
            new(new FakeGateway(), new MemoryStateStore());
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.WebHost.UseTestServer();
        WebApplication app = builder.Build();
        SupportApi.Map(
            app,
            assistant,
            new ApiOptions(
                true,
                new HashSet<string> { "admin" },
                ["manual.md"],
                EvaluationDatasetPath()));
        await app.StartAsync(TestContext.Current.CancellationToken);
        using HttpClient client = app.GetTestClient();
        client.DefaultRequestHeaders.Add(
            "X-MS-CLIENT-PRINCIPAL-ID", "admin");

        try
        {
            HttpResponseMessage response = await client.PostAsJsonAsync(
                "/admin/evaluations",
                new { },
                TestContext.Current.CancellationToken);
            JsonObject accepted = JsonNode.Parse(
                await response.Content.ReadAsStringAsync(
                    TestContext.Current.CancellationToken))!.AsObject();
            string operationId =
                accepted["operationId"]!.GetValue<string>();
            JsonObject? operation = null;
            for (int attempt = 0; attempt < 100; attempt++)
            {
                await Task.Delay(
                    TimeSpan.FromMilliseconds(10),
                    TestContext.Current.CancellationToken);
                operation = JsonNode.Parse(
                    await client.GetStringAsync(
                        $"/admin/operations/{operationId}",
                        TestContext.Current.CancellationToken))!.AsObject();
                if (operation["status"]!.GetValue<string>() != "running")
                {
                    break;
                }
            }

            Assert.NotNull(operation);
            Assert.Equal(
                "failed", operation["status"]!.GetValue<string>());
            Assert.Contains(
                "must be ingested",
                operation["error"]!.GetValue<string>());
        }
        finally
        {
            await app.StopAsync(TestContext.Current.CancellationToken);
            await app.DisposeAsync();
        }
    }

    [Fact]
    public async Task IngestionCommitThenThrowDoesNotDeleteResources()
    {
        FakeGateway gateway = new();
        CommitThenThrowStateStore store = new(1);
        SupportAssistantService assistant = new(gateway, store);

        await assistant.IngestAsync(
            ["manual.md"], TestContext.Current.CancellationToken);

        Assert.NotNull(
            (await store.LoadAsync(
                TestContext.Current.CancellationToken)).Resources);
        Assert.Equal(0, gateway.CleanupCallCount);
    }

    [Fact]
    public async Task NewAnswerCommitThenThrowDoesNotDeleteConversation()
    {
        FakeGateway gateway = new();
        CommitThenThrowStateStore store = new(2);
        SupportAssistantService assistant = new(gateway, store);
        await assistant.IngestAsync(
            ["manual.md"], TestContext.Current.CancellationToken);

        SupportAnswer answer = await assistant.AskAsync(
            "employee-a",
            "chat-1",
            "Reset?",
            TestContext.Current.CancellationToken);

        AssistantState state = await store.LoadAsync(
            TestContext.Current.CancellationToken);
        Assert.Equal(answer.ResponseId, state.Answers[0].ResponseId);
        Assert.Empty(gateway.DeletedConversations);
    }

    [Fact]
    public async Task FollowUpCommitThenThrowDoesNotRollbackTurn()
    {
        FakeGateway gateway = new();
        CommitThenThrowStateStore store = new(3);
        SupportAssistantService assistant = new(gateway, store);
        await assistant.IngestAsync(
            ["manual.md"], TestContext.Current.CancellationToken);
        await assistant.AskAsync(
            "employee-a",
            "chat-1",
            "Reset?",
            TestContext.Current.CancellationToken);

        await assistant.AskAsync(
            "employee-a",
            "chat-1",
            "What happens next?",
            TestContext.Current.CancellationToken);

        Assert.Equal(
            2,
            (await store.LoadAsync(
                TestContext.Current.CancellationToken)).Answers.Count);
        Assert.Empty(gateway.RolledBackTurns);
    }

    private sealed class MemoryStateStore : IStateStore
    {
        private AssistantState _state =
            new() { Loaded = true };
        private int _saveCount;

        public int? FailOnSave { get; set; }

        public Task<AssistantState> LoadAsync(
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return Task.FromResult(Clone(_state));
        }

        public Task SaveAsync(
            AssistantState state,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _saveCount++;
            if (FailOnSave == _saveCount)
            {
                throw new IOException("simulated durable save failure");
            }

            _state = Clone(state);
            return Task.CompletedTask;
        }

        private static AssistantState Clone(AssistantState state)
        {
            string json = System.Text.Json.JsonSerializer.Serialize(state);
            AssistantState clone =
                System.Text.Json.JsonSerializer.Deserialize<AssistantState>(json)!;
            clone.Loaded = true;
            return clone;
        }
    }

    private sealed class CommitThenThrowStateStore : IStateStore
    {
        private readonly MemoryStateStore _delegate = new();
        private readonly int _failOnSave;
        private int _saveCount;

        public CommitThenThrowStateStore(int failOnSave)
        {
            _failOnSave = failOnSave;
        }

        public Task<AssistantState> LoadAsync(
            CancellationToken cancellationToken) =>
            _delegate.LoadAsync(cancellationToken);

        public async Task SaveAsync(
            AssistantState state,
            CancellationToken cancellationToken)
        {
            await _delegate.SaveAsync(state, cancellationToken);
            _saveCount++;
            if (_saveCount == _failOnSave)
            {
                throw new RequestFailedException(
                    500,
                    "Blob committed before response failure.",
                    "ResponseLost",
                    null);
            }
        }
    }

    private static string EvaluationDatasetPath() =>
        Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            "..",
            "..",
            "..",
            "..",
            "..",
            "evaluation",
            "support-cases.jsonl"));

    private sealed class FakeGateway : IFoundryGateway
    {
        private int _answerNumber;

        public List<string?> SeenConversationIds { get; } = [];

        public List<string> DeletedConversations { get; } = [];

        public List<JsonObject> EvaluationRows { get; private set; } = [];

        public Exception? EvaluationFailure { get; init; }

        public Exception? DeleteFailure { get; init; }

        public List<CancellationToken> DeleteTokens { get; } = [];

        public List<(string ConversationId, IReadOnlyList<string> ItemIds)>
            RolledBackTurns { get; } = [];

        public int CleanupCallCount { get; private set; }

        public Task<FoundryResources> IngestAsync(
            IReadOnlyList<string> documentPaths,
            CancellationToken cancellationToken) =>
            Task.FromResult(Resources);

        public Task<GatewayAnswer> AskAsync(
            FoundryResources resources,
            string? conversationId,
            string question,
            CancellationToken cancellationToken)
        {
            SeenConversationIds.Add(conversationId);
            _answerNumber++;
            return Task.FromResult(new GatewayAnswer(
                conversationId ?? $"conversation-{_answerNumber}",
                $"response-{_answerNumber}",
                "Hold reset for ten seconds.",
                [new Citation("file-1", "manual.md")],
                true,
                [$"user-{_answerNumber}", $"assistant-{_answerNumber}"],
                ["Retrieved reset instructions."]));
        }

        public Task DeleteConversationAsync(
            string conversationId,
            CancellationToken cancellationToken)
        {
            DeletedConversations.Add(conversationId);
            DeleteTokens.Add(cancellationToken);
            if (DeleteFailure is not null)
            {
                return Task.FromException(DeleteFailure);
            }
            return Task.CompletedTask;
        }

        public Task RollbackTurnAsync(
            string conversationId,
            IReadOnlyList<string> itemIds,
            CancellationToken cancellationToken)
        {
            RolledBackTurns.Add((conversationId, itemIds));
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<EvaluationMetric>> RunEvaluationAsync(
            IReadOnlyList<JsonObject> rows,
            CancellationToken cancellationToken)
        {
            EvaluationRows = [.. rows];
            if (EvaluationFailure is not null)
            {
                return Task.FromException<IReadOnlyList<EvaluationMetric>>(
                    EvaluationFailure);
            }
            IReadOnlyList<EvaluationMetric> metrics =
            [
                new("item-1", "completed", "groundedness", 5, true)
            ];
            return Task.FromResult(metrics);
        }

        public Task CleanupAsync(
            FoundryResources resources,
            IReadOnlyList<string> conversationIds,
            CancellationToken cancellationToken)
        {
            CleanupCallCount++;
            return Task.CompletedTask;
        }
    }

    private sealed class StaticCredential : TokenCredential
    {
        public override AccessToken GetToken(
            TokenRequestContext requestContext,
            CancellationToken cancellationToken) =>
            new("test-token", DateTimeOffset.UtcNow.AddHours(1));

        public override ValueTask<AccessToken> GetTokenAsync(
            TokenRequestContext requestContext,
            CancellationToken cancellationToken) =>
            ValueTask.FromResult(
                new AccessToken(
                    "test-token", DateTimeOffset.UtcNow.AddHours(1)));
    }

    private sealed class BaselineFailureHandler : HttpMessageHandler
    {
        public bool DeletedConversation { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            string path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Post &&
                path.EndsWith("/conversations", StringComparison.Ordinal))
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = JsonContent.Create(new
                    {
                        id = "conversation-1"
                    })
                });
            }
            if (request.Method == HttpMethod.Get &&
                path.EndsWith(
                    "/conversations/conversation-1/items",
                    StringComparison.Ordinal))
            {
                return Task.FromException<HttpResponseMessage>(
                    new HttpRequestException("connection failed"));
            }
            if (request.Method == HttpMethod.Delete &&
                path.EndsWith(
                    "/conversations/conversation-1",
                    StringComparison.Ordinal))
            {
                DeletedConversation = true;
                return Task.FromResult(
                    new HttpResponseMessage(HttpStatusCode.NoContent));
            }

            return Task.FromException<HttpResponseMessage>(
                new InvalidOperationException(
                    $"Unexpected request: {request.Method} {request.RequestUri}"));
        }
    }

    private sealed class ManagedAgentHandler : HttpMessageHandler
    {
        public JsonObject? AgentRequest { get; private set; }

        public JsonObject? ResponseRequest { get; private set; }

        public bool IngestionCompletedBeforeAgentCreation { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            string path = request.RequestUri!.AbsolutePath;
            if (request.Method == HttpMethod.Post &&
                path.EndsWith("/vector_stores", StringComparison.Ordinal))
            {
                return Json(new { id = "vector-store-1" });
            }
            if (request.Method == HttpMethod.Post &&
                path.EndsWith("/files", StringComparison.Ordinal) &&
                !path.Contains("/vector_stores/", StringComparison.Ordinal))
            {
                return Json(new { id = "file-1" });
            }
            if (request.Method == HttpMethod.Post &&
                path.EndsWith(
                    "/vector_stores/vector-store-1/files",
                    StringComparison.Ordinal))
            {
                return Json(new { id = "file-1" });
            }
            if (request.Method == HttpMethod.Get &&
                path.EndsWith(
                    "/vector_stores/vector-store-1/files/file-1",
                    StringComparison.Ordinal))
            {
                IngestionCompletedBeforeAgentCreation = true;
                return Json(new { status = "completed" });
            }
            if (request.Method == HttpMethod.Post &&
                path.Contains("/agents/", StringComparison.Ordinal) &&
                path.EndsWith("/versions", StringComparison.Ordinal))
            {
                AgentRequest = JsonNode.Parse(
                    await request.Content!.ReadAsStringAsync(
                        cancellationToken))!.AsObject();
                return Json(new { name = "support-agent", version = "1" });
            }
            if (request.Method == HttpMethod.Get &&
                path.EndsWith(
                    "/conversations/conversation-1/items",
                    StringComparison.Ordinal))
            {
                return Json(new
                {
                    data = Array.Empty<object>(),
                    has_more = false
                });
            }
            if (request.Method == HttpMethod.Post &&
                path.EndsWith("/responses", StringComparison.Ordinal))
            {
                ResponseRequest = JsonNode.Parse(
                    await request.Content!.ReadAsStringAsync(
                        cancellationToken))!.AsObject();
                return Json(new
                {
                    id = "response-1",
                    status = "completed",
                    output = new object[]
                    {
                        new
                        {
                            type = "file_search_call",
                            results = new[]
                            {
                                new { text = "Retrieved reset instructions." }
                            }
                        },
                        new
                        {
                            type = "message",
                            content = new[]
                            {
                                new
                                {
                                    type = "output_text",
                                    text = "Hold reset for ten seconds.",
                                    annotations = new[]
                                    {
                                        new
                                        {
                                            type = "file_citation",
                                            file_id = "file-1",
                                            filename = "manual.md"
                                        }
                                    }
                                }
                            }
                        }
                    }
                });
            }

            return await Task.FromException<HttpResponseMessage>(
                new InvalidOperationException(
                    $"Unexpected request: {request.Method} {request.RequestUri}"));
        }

        private static HttpResponseMessage Json(object value) =>
            new(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(value)
            };
    }
}
