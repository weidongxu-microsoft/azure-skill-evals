using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Azure.Core;
using Azure.Identity;

namespace Contoso.SupportAssistant;

public interface IFoundryGateway
{
    Task<FoundryResources> IngestAsync(
        IReadOnlyList<string> documentPaths,
        CancellationToken cancellationToken);

    Task<GatewayAnswer> AskAsync(
        FoundryResources resources,
        string? conversationId,
        string question,
        CancellationToken cancellationToken);

    Task DeleteConversationAsync(
        string conversationId,
        CancellationToken cancellationToken);

    Task RollbackTurnAsync(
        string conversationId,
        IReadOnlyList<string> itemIds,
        CancellationToken cancellationToken);

    Task<IReadOnlyList<EvaluationMetric>> RunEvaluationAsync(
        IReadOnlyList<JsonObject> rows,
        CancellationToken cancellationToken);

    Task CleanupAsync(
        FoundryResources resources,
        IReadOnlyList<string> conversationIds,
        CancellationToken cancellationToken);
}

public sealed class FoundryHttpException(
    HttpStatusCode statusCode,
    string errorCode,
    string message) : HttpRequestException(message, null, statusCode)
{
    public string ErrorCode { get; } = errorCode;
}

public sealed class FoundryRestGateway : IFoundryGateway
{
    private static readonly HashSet<string> FileTerminalStatuses =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "completed", "failed", "cancelled"
        };

    private static readonly HashSet<string> EvaluationTerminalStatuses =
        new(StringComparer.OrdinalIgnoreCase)
        {
            "completed", "failed", "cancelled", "canceled"
        };

    private readonly Uri _baseUri;
    private readonly TokenCredential _credential;
    private readonly HttpClient _httpClient;
    private readonly string _modelDeployment;
    private readonly string _evaluationModelDeployment;
    private readonly string _tokenScope;
    private readonly TimeSpan _pollInterval;
    private readonly TimeSpan _operationTimeout;

    public FoundryRestGateway(
        Uri projectEndpoint,
        TokenCredential credential,
        HttpClient httpClient,
        string modelDeployment,
        string evaluationModelDeployment,
        string tokenScope,
        TimeSpan? pollInterval = null,
        TimeSpan? operationTimeout = null)
    {
        _baseUri = new Uri(
            $"{projectEndpoint.ToString().TrimEnd('/')}/openai/v1/");
        _credential = credential;
        _httpClient = httpClient;
        _modelDeployment = modelDeployment;
        _evaluationModelDeployment = evaluationModelDeployment;
        _tokenScope = tokenScope;
        _pollInterval = pollInterval ?? TimeSpan.FromSeconds(2);
        _operationTimeout = operationTimeout ?? TimeSpan.FromMinutes(10);
    }

    public async Task<FoundryResources> IngestAsync(
        IReadOnlyList<string> documentPaths,
        CancellationToken cancellationToken)
    {
        if (documentPaths.Count == 0)
        {
            throw new ArgumentException(
                "At least one product document is required.",
                nameof(documentPaths));
        }

        JsonObject vectorStore = await SendJsonAsync(
            HttpMethod.Post,
            "vector_stores",
            new JsonObject
            {
                ["name"] = $"contoso-support-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}"
            },
            cancellationToken);
        string vectorStoreId = RequiredString(vectorStore, "id");
        List<string> fileIds = [];
        FoundryResources resources = new(vectorStoreId, fileIds);

        try
        {
            foreach (string documentPath in documentPaths)
            {
                string fileId = await UploadFileAsync(
                    documentPath, cancellationToken);
                fileIds.Add(fileId);
                JsonObject attached = await SendJsonAsync(
                    HttpMethod.Post,
                    $"vector_stores/{Escape(vectorStoreId)}/files",
                    new JsonObject { ["file_id"] = fileId },
                    cancellationToken);
                string attachedId = RequiredString(attached, "id");
                string status = await PollVectorStoreFileAsync(
                    vectorStoreId, attachedId, cancellationToken);
                if (!status.Equals("completed", StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException(
                        $"Indexing {Path.GetFileName(documentPath)} ended with status {status}.");
                }
            }

            return new FoundryResources(vectorStoreId, [.. fileIds]);
        }
        catch (Exception error) when (
            IsGatewayFailure(error))
        {
            try
            {
                await CleanupAsync(resources, [], CancellationToken.None);
            }
            catch (Exception cleanupError) when (
                IsCleanupFailure(cleanupError))
            {
                throw new AggregateException(
                    "Ingestion failed and created resources were not fully deleted.",
                    error,
                    cleanupError);
            }

            throw;
        }
    }

    public async Task<GatewayAnswer> AskAsync(
        FoundryResources resources,
        string? conversationId,
        string question,
        CancellationToken cancellationToken)
    {
        string activeConversationId = conversationId ?? RequiredString(
            await SendJsonAsync(
                HttpMethod.Post,
                "conversations",
                new JsonObject(),
                cancellationToken),
            "id");
        bool createdConversation = conversationId is null;
        HashSet<string> beforeIds;
        try
        {
            beforeIds = await ConversationItemIdsAsync(
                activeConversationId, cancellationToken);
        }
        catch (Exception error) when (IsGatewayFailure(error))
        {
            if (!createdConversation)
            {
                throw;
            }

            try
            {
                await DeleteConversationRecordAsync(
                    activeConversationId, CancellationToken.None);
            }
            catch (Exception cleanupError) when (
                IsCleanupFailure(cleanupError))
            {
                throw new AggregateException(
                    "The new conversation baseline could not be loaded and " +
                    "the conversation could not be deleted.",
                    error,
                    cleanupError);
            }

            throw;
        }

        try
        {
            JsonObject response = await SendJsonAsync(
                HttpMethod.Post,
                "responses",
                new JsonObject
                {
                    ["model"] = _modelDeployment,
                    ["conversation"] = activeConversationId,
                    ["input"] = question,
                    ["instructions"] =
                        "You are Contoso's internal product-support assistant. " +
                        "Search the indexed product documentation before answering. " +
                        "Answer only from retrieved documentation. If it does not " +
                        "support an answer, begin with 'UNSUPPORTED:'. Preserve " +
                        "file citations for supported answers.",
                    ["tools"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["type"] = "file_search",
                            ["vector_store_ids"] = new JsonArray(
                                resources.VectorStoreId),
                            ["max_num_results"] = 10
                        }
                    },
                    ["tool_choice"] = "required",
                    ["include"] = new JsonArray("file_search_call.results")
                },
                cancellationToken);
            string status = RequiredString(response, "status");
            if (!status.Equals("completed", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Foundry response ended with status {status}.");
            }

            HashSet<string> afterIds = await ConversationItemIdsAsync(
                activeConversationId, cancellationToken);
            List<string> turnItemIds =
                afterIds.Except(beforeIds, StringComparer.Ordinal).ToList();
            (string text, List<Citation> citations, List<string> context) =
                ParseResponse(response);
            return new GatewayAnswer(
                activeConversationId,
                RequiredString(response, "id"),
                text,
                citations,
                citations.Count > 0 &&
                    !text.StartsWith(
                        "UNSUPPORTED:",
                        StringComparison.OrdinalIgnoreCase),
                turnItemIds,
                context);
        }
        catch (Exception error) when (
            IsGatewayFailure(error))
        {
            try
            {
                if (createdConversation)
                {
                    await DeleteConversationRecordAsync(
                        activeConversationId, CancellationToken.None);
                }
                else
                {
                    HashSet<string> currentIds = await ConversationItemIdsAsync(
                        activeConversationId, CancellationToken.None);
                    await RollbackTurnAsync(
                        activeConversationId,
                        currentIds.Except(
                            beforeIds, StringComparer.Ordinal).ToList(),
                        CancellationToken.None);
                }
            }
            catch (Exception cleanupError) when (
                IsCleanupFailure(cleanupError))
            {
                throw new AggregateException(
                    "The answer failed and conversation changes were not rolled back.",
                    error,
                    cleanupError);
            }

            throw;
        }
    }

    public async Task DeleteConversationAsync(
        string conversationId,
        CancellationToken cancellationToken)
    {
        await RollbackTurnAsync(
            conversationId,
            [.. await ConversationItemIdsAsync(
                conversationId, cancellationToken)],
            cancellationToken);
        await SendJsonAsync(
            HttpMethod.Delete,
            $"conversations/{Escape(conversationId)}",
            null,
            cancellationToken);
    }

    public async Task RollbackTurnAsync(
        string conversationId,
        IReadOnlyList<string> itemIds,
        CancellationToken cancellationToken)
    {
        List<Exception> failures = [];
        foreach (string itemId in itemIds)
        {
            try
            {
                await SendJsonAsync(
                    HttpMethod.Delete,
                    $"conversations/{Escape(conversationId)}/items/{Escape(itemId)}",
                    null,
                    cancellationToken);
            }
            catch (FoundryHttpException error)
                when (error.StatusCode == HttpStatusCode.NotFound)
            {
            }
            catch (FoundryHttpException error)
            {
                failures.Add(error);
            }
            catch (Exception error) when (
                error is AuthenticationFailedException or
                    HttpRequestException or OperationCanceledException or
                    TimeoutException)
            {
                failures.Add(error);
            }
        }

        if (failures.Count > 0)
        {
            throw new AggregateException(
                "The conversation turn was not rolled back.", failures);
        }
    }

    public async Task<IReadOnlyList<EvaluationMetric>> RunEvaluationAsync(
        IReadOnlyList<JsonObject> rows,
        CancellationToken cancellationToken)
    {
        if (rows.Count == 0)
        {
            throw new ArgumentException(
                "At least one evaluation row is required.", nameof(rows));
        }

        JsonArray criteria =
        [
            new JsonObject
            {
                ["type"] = "azure_ai_evaluator",
                ["name"] = "groundedness",
                ["evaluator_name"] = "builtin.groundedness",
                ["initialization_parameters"] = new JsonObject
                {
                    ["deployment_name"] = _evaluationModelDeployment
                },
                ["data_mapping"] = new JsonObject
                {
                    ["query"] = "{{item.query}}",
                    ["response"] = "{{item.response}}",
                    ["context"] = "{{item.context}}"
                }
            },
            new JsonObject
            {
                ["type"] = "azure_ai_evaluator",
                ["name"] = "relevance",
                ["evaluator_name"] = "builtin.relevance",
                ["initialization_parameters"] = new JsonObject
                {
                    ["deployment_name"] = _evaluationModelDeployment
                },
                ["data_mapping"] = new JsonObject
                {
                    ["query"] = "{{item.query}}",
                    ["response"] = "{{item.response}}"
                }
            }
        ];
        JsonObject evaluation = await SendJsonAsync(
            HttpMethod.Post,
            "evals",
            new JsonObject
            {
                ["name"] =
                    $"contoso-support-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}",
                ["data_source_config"] = new JsonObject
                {
                    ["type"] = "custom",
                    ["item_schema"] = new JsonObject
                    {
                        ["type"] = "object",
                        ["properties"] = new JsonObject
                        {
                            ["query"] = StringSchema(),
                            ["response"] = StringSchema(),
                            ["context"] = StringSchema(),
                            ["ground_truth"] = StringSchema()
                        },
                        ["required"] = new JsonArray(
                            "query", "response", "context", "ground_truth")
                    },
                    ["include_sample_schema"] = true
                },
                ["testing_criteria"] = criteria
            },
            cancellationToken);
        string evaluationId = RequiredString(evaluation, "id");

        Exception? evaluationError = null;
        IReadOnlyList<EvaluationMetric> metrics = [];
        try
        {
            JsonArray content = [];
            foreach (JsonObject row in rows)
            {
                content.Add(new JsonObject { ["item"] = row.DeepClone() });
            }

            JsonObject run = await SendJsonAsync(
                HttpMethod.Post,
                $"evals/{Escape(evaluationId)}/runs",
                new JsonObject
                {
                    ["name"] =
                        $"contoso-support-run-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}",
                    ["data_source"] = new JsonObject
                    {
                        ["type"] = "jsonl",
                        ["source"] = new JsonObject
                        {
                            ["type"] = "file_content",
                            ["content"] = content
                        }
                    }
                },
                cancellationToken);
            string runId = RequiredString(run, "id");
            DateTimeOffset deadline = DateTimeOffset.UtcNow + _operationTimeout;
            string status = RequiredString(run, "status");
            while (!EvaluationTerminalStatuses.Contains(status))
            {
                await DelayOrThrowAsync(
                    deadline, $"Evaluation run {runId}", cancellationToken);
                run = await SendJsonAsync(
                    HttpMethod.Get,
                    $"evals/{Escape(evaluationId)}/runs/{Escape(runId)}",
                    null,
                    cancellationToken);
                status = RequiredString(run, "status");
            }

            if (!status.Equals("completed", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    $"Evaluation run {runId} ended with status {status}.");
            }

            List<EvaluationMetric> collectedMetrics = [];
            await foreach (JsonObject item in PagedDataAsync(
                $"evals/{Escape(evaluationId)}/runs/{Escape(runId)}/output_items?limit=100",
                cancellationToken))
            {
                string itemId = RequiredString(item, "id");
                string itemStatus = RequiredString(item, "status");
                if (item["results"] is not JsonArray results)
                {
                    throw new InvalidDataException(
                        "Evaluation output results must be an array.");
                }

                foreach (JsonNode? resultNode in results)
                {
                    if (resultNode is not JsonObject result)
                    {
                        throw new InvalidDataException(
                            "Evaluation result must be an object.");
                    }

                    collectedMetrics.Add(new EvaluationMetric(
                        itemId,
                        itemStatus,
                        RequiredString(result, "name"),
                        result["score"]?.GetValue<double>(),
                        result["passed"]?.GetValue<bool>()));
                }
            }
            metrics = collectedMetrics;
        }
        catch (Exception error) when (IsGatewayFailure(error))
        {
            evaluationError = error;
        }

        Exception? cleanupError = null;
        try
        {
            await SendJsonAsync(
                HttpMethod.Delete,
                $"evals/{Escape(evaluationId)}",
                null,
                CancellationToken.None);
        }
        catch (Exception error) when (IsCleanupFailure(error))
        {
            cleanupError = error;
        }

        if (evaluationError is not null && cleanupError is not null)
        {
            throw new AggregateException(
                "Evaluation failed and its definition could not be deleted.",
                evaluationError,
                cleanupError);
        }
        if (evaluationError is not null)
        {
            throw evaluationError;
        }
        if (cleanupError is not null)
        {
            throw cleanupError;
        }
        return metrics;
    }

    public async Task CleanupAsync(
        FoundryResources resources,
        IReadOnlyList<string> conversationIds,
        CancellationToken cancellationToken)
    {
        List<Exception> failures = [];
        foreach (string conversationId in conversationIds.Distinct(
            StringComparer.Ordinal))
        {
            await DeleteForCleanupAsync(
                () => DeleteConversationAsync(
                    conversationId, cancellationToken),
                failures);
        }
        ThrowCleanupFailures(failures);

        await DeleteForCleanupAsync(
            () => SendJsonAsync(
                HttpMethod.Delete,
                $"vector_stores/{Escape(resources.VectorStoreId)}",
                null,
                cancellationToken),
            failures);
        ThrowCleanupFailures(failures);
        foreach (string fileId in resources.FileIds)
        {
            await DeleteForCleanupAsync(
                () => SendJsonAsync(
                    HttpMethod.Delete,
                    $"files/{Escape(fileId)}",
                    null,
                    cancellationToken),
                failures);
        }
        ThrowCleanupFailures(failures);
    }

    private async Task<string> UploadFileAsync(
        string documentPath,
        CancellationToken cancellationToken)
    {
        await using FileStream stream = File.OpenRead(documentPath);
        using MultipartFormDataContent content = [];
        content.Add(new StringContent("assistants"), "purpose");
        using StreamContent fileContent = new(stream);
        fileContent.Headers.ContentType =
            new MediaTypeHeaderValue("text/markdown");
        content.Add(fileContent, "file", Path.GetFileName(documentPath));
        using HttpRequestMessage request = new(
            HttpMethod.Post, new Uri(_baseUri, "files"))
        {
            Content = content
        };
        JsonObject response = await SendAsync(request, cancellationToken);
        return RequiredString(response, "id");
    }

    private async Task<string> PollVectorStoreFileAsync(
        string vectorStoreId,
        string fileId,
        CancellationToken cancellationToken)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow + _operationTimeout;
        while (true)
        {
            JsonObject file = await SendJsonAsync(
                HttpMethod.Get,
                $"vector_stores/{Escape(vectorStoreId)}/files/{Escape(fileId)}",
                null,
                cancellationToken);
            string status = RequiredString(file, "status");
            if (FileTerminalStatuses.Contains(status))
            {
                return status;
            }

            await DelayOrThrowAsync(
                deadline, $"Vector-store file {fileId}", cancellationToken);
        }
    }

    private async Task<HashSet<string>> ConversationItemIdsAsync(
        string conversationId,
        CancellationToken cancellationToken)
    {
        HashSet<string> itemIds = new(StringComparer.Ordinal);
        await foreach (JsonObject item in PagedDataAsync(
            $"conversations/{Escape(conversationId)}/items?limit=100",
            cancellationToken))
        {
            itemIds.Add(RequiredString(item, "id"));
        }

        return itemIds;
    }

    private async IAsyncEnumerable<JsonObject> PagedDataAsync(
        string path,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        string? nextPath = path;
        while (nextPath is not null)
        {
            JsonObject page = await SendJsonAsync(
                HttpMethod.Get, nextPath, null, cancellationToken);
            if (page["data"] is not JsonArray data)
            {
                throw new InvalidDataException(
                    "Paged response data must be an array.");
            }

            foreach (JsonNode? item in data)
            {
                yield return item as JsonObject
                    ?? throw new InvalidDataException(
                        "Paged response item must be an object.");
            }

            nextPath = page["has_more"]?.GetValue<bool>() == true
                ? $"{path}{(path.Contains('?', StringComparison.Ordinal) ? '&' : '?')}" +
                    $"after={Escape(RequiredString(page, "last_id"))}"
                : null;
        }
    }

    private async Task<JsonObject> SendJsonAsync(
        HttpMethod method,
        string path,
        JsonObject? body,
        CancellationToken cancellationToken)
    {
        using HttpRequestMessage request = new(
            method, new Uri(_baseUri, path));
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await SendAsync(request, cancellationToken);
    }

    private async Task<JsonObject> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        AccessToken token = await _credential.GetTokenAsync(
            new TokenRequestContext([_tokenScope]), cancellationToken);
        request.Headers.Authorization =
            new AuthenticationHeaderValue("Bearer", token.Token);
        using HttpResponseMessage response = await _httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);
        string content = await response.Content.ReadAsStringAsync(
            cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            (string code, string message) = ServiceError(content);
            throw new FoundryHttpException(
                response.StatusCode,
                code,
                $"Foundry request failed: status={(int)response.StatusCode} " +
                $"code={code} message={message}");
        }

        if (response.StatusCode == HttpStatusCode.NoContent ||
            string.IsNullOrWhiteSpace(content))
        {
            return new JsonObject();
        }

        return JsonNode.Parse(content) as JsonObject
            ?? throw new InvalidDataException(
                "Foundry response must be a JSON object.");
    }

    private async Task DeleteForCleanupAsync(
        Func<Task> operation,
        List<Exception> failures)
    {
        try
        {
            await operation();
        }
        catch (FoundryHttpException error)
            when (error.StatusCode == HttpStatusCode.NotFound)
        {
        }
        catch (Exception error) when (
            IsCleanupFailure(error))
        {
            failures.Add(error);
        }
    }

    private static void ThrowCleanupFailures(List<Exception> failures)
    {
        if (failures.Count > 0)
        {
            throw new AggregateException(
                "Some Foundry resources were not deleted.", failures);
        }
    }

    private async Task DeleteConversationRecordAsync(
        string conversationId,
        CancellationToken cancellationToken)
    {
        try
        {
            await SendJsonAsync(
                HttpMethod.Delete,
                $"conversations/{Escape(conversationId)}",
                null,
                cancellationToken);
        }
        catch (FoundryHttpException error)
            when (error.StatusCode == HttpStatusCode.NotFound)
        {
        }
    }

    private static bool IsGatewayFailure(Exception error) =>
        error is AuthenticationFailedException or FoundryHttpException or
            HttpRequestException or IOException or InvalidOperationException or
            JsonException or OperationCanceledException or TimeoutException;

    private static bool IsCleanupFailure(Exception error) =>
        error is AggregateException or AuthenticationFailedException or
            FoundryHttpException or HttpRequestException or IOException or
            InvalidOperationException or OperationCanceledException or
            TimeoutException;

    private async Task DelayOrThrowAsync(
        DateTimeOffset deadline,
        string operation,
        CancellationToken cancellationToken)
    {
        if (DateTimeOffset.UtcNow >= deadline)
        {
            throw new TimeoutException(
                $"{operation} did not finish within {_operationTimeout}.");
        }

        await Task.Delay(_pollInterval, cancellationToken);
    }

    private static (string Text, List<Citation> Citations, List<string> Context)
        ParseResponse(JsonObject response)
    {
        if (response["output"] is not JsonArray output)
        {
            throw new InvalidDataException(
                "Foundry response output must be an array.");
        }

        StringBuilder text = new();
        Dictionary<string, Citation> citations =
            new(StringComparer.Ordinal);
        List<string> context = [];
        foreach (JsonNode? itemNode in output)
        {
            if (itemNode is not JsonObject item)
            {
                continue;
            }

            if (item["type"]?.GetValue<string>() == "file_search_call" &&
                item["results"] is JsonArray results)
            {
                foreach (JsonNode? result in results)
                {
                    string? chunk = result?["text"]?.GetValue<string>();
                    if (!string.IsNullOrWhiteSpace(chunk))
                    {
                        context.Add(chunk.Trim());
                    }
                }
            }

            if (item["type"]?.GetValue<string>() != "message" ||
                item["content"] is not JsonArray parts)
            {
                continue;
            }

            foreach (JsonNode? partNode in parts)
            {
                if (partNode is not JsonObject part ||
                    part["type"]?.GetValue<string>() != "output_text")
                {
                    continue;
                }

                text.Append(part["text"]?.GetValue<string>());
                if (part["annotations"] is not JsonArray annotations)
                {
                    continue;
                }

                foreach (JsonNode? annotationNode in annotations)
                {
                    if (annotationNode is JsonObject annotation &&
                        annotation["type"]?.GetValue<string>() ==
                            "file_citation")
                    {
                        string fileId = RequiredString(
                            annotation, "file_id");
                        citations[fileId] = new Citation(
                            fileId,
                            RequiredString(annotation, "filename"));
                    }
                }
            }
        }

        string answer = text.ToString().Trim();
        if (answer.Length == 0)
        {
            throw new InvalidDataException(
                "Foundry response contained no output text.");
        }

        return (answer, [.. citations.Values], context);
    }

    private static (string Code, string Message) ServiceError(string content)
    {
        try
        {
            JsonObject? root = JsonNode.Parse(content) as JsonObject;
            JsonObject? error = root?["error"] as JsonObject ?? root;
            return (
                error?["code"]?.GetValue<string>() ?? "unknown",
                error?["message"]?.GetValue<string>() ?? content);
        }
        catch (JsonException)
        {
            return ("unknown", content);
        }
    }

    private static JsonObject StringSchema() =>
        new() { ["type"] = "string" };

    private static string RequiredString(JsonObject value, string property) =>
        value[property]?.GetValue<string>()
        ?? throw new InvalidDataException(
            $"Foundry property {property} must be a string.");

    private static string Escape(string value) =>
        Uri.EscapeDataString(value);
}
