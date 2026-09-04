using System.Text.Json;
using System.Text.Json.Nodes;
using Azure;
using Azure.Identity;

namespace Contoso.SupportAssistant;

public sealed class SupportAssistantException(
    string code,
    string message) : Exception(message)
{
    public string Code { get; } = code;
}

public sealed class SupportAssistantService(
    IFoundryGateway gateway,
    IStateStore store)
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task IngestAsync(
        IReadOnlyList<string> documentPaths,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            AssistantState state = await store.LoadAsync(cancellationToken);
            if (state.Resources is not null)
            {
                throw new SupportAssistantException(
                    "already_ingested",
                    "Product documentation is already ingested.");
            }

            FoundryResources resources = await gateway.IngestAsync(
                documentPaths, cancellationToken);
            state.Resources = resources;
            try
            {
                await store.SaveAsync(state, cancellationToken);
            }
            catch (Exception error) when (
                IsKnownFailure(error))
            {
                AssistantState reloaded = await ReloadAfterFailedSaveAsync(
                    "Could not verify ingestion state for " +
                    $"vectorStoreId={resources.VectorStoreId} " +
                    $"fileIds={string.Join(',', resources.FileIds)}.",
                    error);
                if (ResourcesMatch(reloaded.Resources, resources))
                {
                    return;
                }
                if (reloaded.Resources is not null)
                {
                    throw new AggregateException(
                        "Ingestion state is ambiguous for " +
                        $"vectorStoreId={resources.VectorStoreId}; " +
                        "no Foundry resources were deleted.",
                        error,
                        new InvalidOperationException(
                            "Durable state contains different resource " +
                            $"ownership: vectorStoreId=" +
                            $"{reloaded.Resources.VectorStoreId}."));
                }
                try
                {
                    await gateway.CleanupAsync(
                        resources, [], CancellationToken.None);
                }
                catch (Exception cleanupError) when (
                    IsCleanupFailure(cleanupError))
                {
                    throw new AggregateException(
                        "State persistence failed and new Foundry resources " +
                        "were not fully deleted.",
                        error,
                        cleanupError);
                }

                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<SupportAnswer> AskAsync(
        string employeeId,
        string localConversationId,
        string question,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            AssistantState state = await store.LoadAsync(cancellationToken);
            FoundryResources resources = state.Resources
                ?? throw new SupportAssistantException(
                    "not_ingested",
                    "Product documentation must be ingested before questions.");
            string key = ConversationKey(employeeId, localConversationId);
            state.Conversations.TryGetValue(
                key, out string? existingConversationId);
            GatewayAnswer gatewayAnswer = await gateway.AskAsync(
                resources,
                existingConversationId,
                question,
                cancellationToken);
            SupportAnswer answer = new(
                gatewayAnswer.ConversationId,
                gatewayAnswer.ResponseId,
                gatewayAnswer.Text,
                gatewayAnswer.Citations,
                gatewayAnswer.Supported);
            string createdAt = DateTimeOffset.UtcNow.ToString("O");
            state.Conversations[key] = answer.ConversationId;
            StoredAnswer storedAnswer = new(
                employeeId,
                localConversationId,
                question,
                createdAt,
                answer.ConversationId,
                answer.ResponseId,
                answer.Text,
                answer.Citations,
                answer.Supported);
            state.Answers.Add(storedAnswer);
            UnresolvedQuestion? unresolved = null;
            if (!answer.Supported)
            {
                unresolved = new UnresolvedQuestion(
                    employeeId,
                    localConversationId,
                    question,
                    answer.ResponseId,
                    createdAt);
                state.UnresolvedQuestions.Add(unresolved);
            }

            try
            {
                await store.SaveAsync(state, cancellationToken);
            }
            catch (Exception error) when (
                IsKnownFailure(error))
            {
                AssistantState reloaded = await ReloadAfterFailedSaveAsync(
                    "Could not verify answer state for " +
                    $"conversationId={answer.ConversationId} " +
                    $"responseId={answer.ResponseId}.",
                    error);
                if (AnswerCommitted(
                    reloaded, key, storedAnswer, unresolved))
                {
                    return answer;
                }
                if (!AnswerAbsent(
                    reloaded,
                    key,
                    existingConversationId,
                    answer.ResponseId))
                {
                    throw new AggregateException(
                        "Answer state is ambiguous for " +
                        $"conversationId={answer.ConversationId} " +
                        $"responseId={answer.ResponseId}; the Foundry " +
                        "conversation was not deleted or rolled back.",
                        error,
                        new InvalidOperationException(
                            "Durable state contains only part of the " +
                            "intended answer/conversation mutation."));
                }
                try
                {
                    if (existingConversationId is null)
                    {
                        await gateway.DeleteConversationAsync(
                            answer.ConversationId, CancellationToken.None);
                    }
                    else
                    {
                        await gateway.RollbackTurnAsync(
                            answer.ConversationId,
                            gatewayAnswer.TurnItemIds,
                            CancellationToken.None);
                    }
                }
                catch (Exception cleanupError) when (
                    IsCleanupFailure(cleanupError))
                {
                    throw new AggregateException(
                        "State persistence failed and the Foundry turn " +
                        "was not compensated.",
                        error,
                        cleanupError);
                }

                throw;
            }

            return answer;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task RecordFeedbackAsync(
        string employeeId,
        string localConversationId,
        string responseId,
        string rating,
        string? comment,
        CancellationToken cancellationToken)
    {
        if (rating is not ("positive" or "negative"))
        {
            throw new ArgumentException(
                "rating must be positive or negative.", nameof(rating));
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            AssistantState state = await store.LoadAsync(cancellationToken);
            StoredAnswer? answer = state.Answers.Find(item =>
                item.ResponseId == responseId &&
                item.EmployeeId == employeeId &&
                item.LocalConversationId == localConversationId);
            if (answer is null)
            {
                throw new SupportAssistantException(
                    "response_not_found",
                    "The response is unknown or belongs to another employee " +
                    "or conversation.");
            }

            state.Feedback.Add(new FeedbackRecord(
                employeeId,
                localConversationId,
                responseId,
                rating,
                comment,
                DateTimeOffset.UtcNow.ToString("O")));
            await store.SaveAsync(state, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<IReadOnlyList<EvaluationMetric>> EvaluateAsync(
        IReadOnlyList<EvaluationCase> cases,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            AssistantState state = await store.LoadAsync(cancellationToken);
            FoundryResources resources = state.Resources
                ?? throw new SupportAssistantException(
                    "not_ingested",
                    "Product documentation must be ingested before evaluation.");
            List<JsonObject> rows = [];
            List<string> conversationIds = [];
            Exception? evaluationError = null;
            IReadOnlyList<EvaluationMetric> metrics = [];

            try
            {
                foreach (EvaluationCase evaluationCase in cases)
                {
                    GatewayAnswer answer = await gateway.AskAsync(
                        resources,
                        null,
                        evaluationCase.Query,
                        cancellationToken);
                    conversationIds.Add(answer.ConversationId);
                    if (answer.RetrievedContext.Count == 0)
                    {
                        throw new InvalidOperationException(
                            $"Evaluation case {evaluationCase.Id} returned " +
                            "no retrieved context.");
                    }

                    rows.Add(new JsonObject
                    {
                        ["query"] = evaluationCase.Query,
                        ["response"] = answer.Text,
                        ["context"] = string.Join(
                            "\n\n", answer.RetrievedContext),
                        ["ground_truth"] = evaluationCase.GroundTruth
                    });
                }

                metrics = await gateway.RunEvaluationAsync(
                    rows, cancellationToken);
            }
            catch (Exception error) when (
                IsKnownFailure(error))
            {
                evaluationError = error;
            }

            List<Exception> cleanupErrors = [];
            foreach (string conversationId in conversationIds)
            {
                try
                {
                    await gateway.DeleteConversationAsync(
                        conversationId, CancellationToken.None);
                }
                catch (Exception error) when (
                    IsCleanupFailure(error))
                {
                    cleanupErrors.Add(error);
                }
            }

            if (evaluationError is not null && cleanupErrors.Count > 0)
            {
                throw new AggregateException(
                    "Evaluation and temporary conversation cleanup failed.",
                    [evaluationError, .. cleanupErrors]);
            }

            if (evaluationError is not null)
            {
                throw evaluationError;
            }

            if (cleanupErrors.Count > 0)
            {
                throw new AggregateException(
                    "Temporary evaluation conversations were not deleted.",
                    cleanupErrors);
            }

            return metrics;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task CleanupAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            AssistantState state = await store.LoadAsync(cancellationToken);
            if (state.Resources is null)
            {
                return;
            }

            await gateway.CleanupAsync(
                state.Resources,
                [.. state.Conversations.Values],
                cancellationToken);
            state.Resources = null;
            state.Conversations.Clear();
            await store.SaveAsync(state, cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<IReadOnlyList<UnresolvedQuestion>>
        ListUnresolvedAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return [.. (await store.LoadAsync(cancellationToken))
                .UnresolvedQuestions];
        }
        finally
        {
            _gate.Release();
        }
    }

    private static string ConversationKey(
        string employeeId,
        string conversationId) =>
        $"{employeeId}:{conversationId}";

    private async Task<AssistantState> ReloadAfterFailedSaveAsync(
        string message,
        Exception error)
    {
        try
        {
            return await store.LoadAsync(CancellationToken.None);
        }
        catch (Exception reloadError) when (IsKnownFailure(reloadError))
        {
            throw new AggregateException(
                $"{message} No destructive compensation was attempted.",
                error,
                reloadError);
        }
    }

    private static bool ResourcesMatch(
        FoundryResources? actual,
        FoundryResources expected) =>
        actual is not null &&
        actual.VectorStoreId == expected.VectorStoreId &&
        actual.FileIds.SequenceEqual(expected.FileIds, StringComparer.Ordinal);

    private static bool AnswerCommitted(
        AssistantState state,
        string key,
        StoredAnswer expected,
        UnresolvedQuestion? unresolved) =>
        state.Conversations.TryGetValue(key, out string? conversationId) &&
        conversationId == expected.ConversationId &&
        state.Answers.Any(item => StoredAnswerMatches(item, expected)) &&
        (unresolved is null ||
            state.UnresolvedQuestions.Contains(unresolved));

    private static bool AnswerAbsent(
        AssistantState state,
        string key,
        string? existingConversationId,
        string responseId)
    {
        bool mappingUnchanged = existingConversationId is null
            ? !state.Conversations.ContainsKey(key)
            : state.Conversations.TryGetValue(key, out string? value) &&
                value == existingConversationId;
        return mappingUnchanged &&
            state.Answers.All(item => item.ResponseId != responseId) &&
            state.UnresolvedQuestions.All(
                item => item.ResponseId != responseId);
    }

    private static bool StoredAnswerMatches(
        StoredAnswer actual,
        StoredAnswer expected) =>
        actual.EmployeeId == expected.EmployeeId &&
        actual.LocalConversationId == expected.LocalConversationId &&
        actual.Question == expected.Question &&
        actual.CreatedAt == expected.CreatedAt &&
        actual.ConversationId == expected.ConversationId &&
        actual.ResponseId == expected.ResponseId &&
        actual.Text == expected.Text &&
        actual.Supported == expected.Supported &&
        actual.Citations.SequenceEqual(expected.Citations);

    private static bool IsKnownFailure(Exception error) =>
        error is AggregateException or AuthenticationFailedException or
            FoundryHttpException or HttpRequestException or IOException or
            InvalidOperationException or JsonException or
            OperationCanceledException or RequestFailedException or
            TimeoutException;

    private static bool IsCleanupFailure(Exception error) =>
        error is AggregateException or AuthenticationFailedException or
            FoundryHttpException or HttpRequestException or IOException or
            InvalidOperationException or JsonException or
            OperationCanceledException or RequestFailedException or
            TimeoutException;
}
