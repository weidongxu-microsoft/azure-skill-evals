using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Azure;
using Azure.Identity;

namespace Contoso.SupportAssistant;

public sealed record ApiOptions(
    bool RequireAuthentication,
    IReadOnlySet<string> AdminPrincipalIds,
    IReadOnlyList<string> Materials,
    string EvaluationDataset);

public sealed record QuestionRequest(string Question);

public sealed record FeedbackRequest(
    string ResponseId,
    string Rating,
    string? Comment);

public sealed record OperationRecord(
    string Status,
    object? Result = null,
    string? Error = null);

public static class SupportApi
{
    public static void Map(
        WebApplication app,
        SupportAssistantService assistant,
        ApiOptions options)
    {
        ConcurrentDictionary<string, OperationRecord> operations = [];

        app.Use(async (context, next) =>
        {
            try
            {
                await next(context);
            }
            catch (BadHttpRequestException error)
            {
                await Results.Json(
                    new { error = error.Message },
                    statusCode: error.StatusCode).ExecuteAsync(context);
            }
            catch (SupportAssistantException error)
            {
                int status = error.Code == "response_not_found"
                    ? StatusCodes.Status404NotFound
                    : StatusCodes.Status409Conflict;
                await Results.Json(
                    new { error = error.Message, code = error.Code },
                    statusCode: status).ExecuteAsync(context);
            }
            catch (FoundryHttpException error)
            {
                await Results.Json(
                    new
                    {
                        error = error.Message,
                        azureStatus = (int?)error.StatusCode,
                        azureCode = error.ErrorCode
                    },
                    statusCode: StatusCodes.Status502BadGateway)
                    .ExecuteAsync(context);
            }
            catch (RequestFailedException error)
            {
                await Results.Json(
                    new
                    {
                        error = error.Message,
                        azureStatus = error.Status,
                        azureCode = error.ErrorCode
                    },
                    statusCode: StatusCodes.Status502BadGateway)
                    .ExecuteAsync(context);
            }
            catch (AuthenticationFailedException error)
            {
                await Results.Json(
                    new
                    {
                        error = error.Message,
                        azureCode = "authentication_failed"
                    },
                    statusCode: StatusCodes.Status502BadGateway)
                    .ExecuteAsync(context);
            }
            catch (HttpRequestException error)
            {
                await Results.Json(
                    new
                    {
                        error = error.Message,
                        azureCode = "transport_error"
                    },
                    statusCode: StatusCodes.Status502BadGateway)
                    .ExecuteAsync(context);
            }
            catch (TimeoutException error)
            {
                await Results.Json(
                    new { error = error.Message, azureCode = "timeout" },
                    statusCode: StatusCodes.Status504GatewayTimeout)
                    .ExecuteAsync(context);
            }
            catch (OperationCanceledException error)
            {
                await Results.Json(
                    new { error = error.Message, azureCode = "cancelled" },
                    statusCode: StatusCodes.Status503ServiceUnavailable)
                    .ExecuteAsync(context);
            }
            catch (AggregateException error)
            {
                app.Logger.LogError(error, "Request cleanup failed");
                await Results.Json(
                    new { error = error.Message },
                    statusCode: StatusCodes.Status500InternalServerError)
                    .ExecuteAsync(context);
            }
            catch (Exception error) when (
                error is ArgumentException or JsonException)
            {
                await Results.Json(
                    new { error = error.Message },
                    statusCode: StatusCodes.Status400BadRequest)
                    .ExecuteAsync(context);
            }
            catch (Exception error) when (
                error is IOException or InvalidOperationException)
            {
                app.Logger.LogError(error, "Request failed");
                await Results.Json(
                    new { error = error.Message },
                    statusCode: StatusCodes.Status500InternalServerError)
                    .ExecuteAsync(context);
            }
        });

        app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

        app.MapPost("/admin/ingest", async (
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            string principalId = PrincipalId(context, options);
            RequireAdministrator(principalId, options);
            await assistant.IngestAsync(options.Materials, cancellationToken);
            return Results.Json(
                new { status = "ingested" },
                statusCode: StatusCodes.Status201Created);
        });

        app.MapPost("/conversations/{conversationId}/messages", async (
            HttpContext context,
            string conversationId,
            QuestionRequest request,
            CancellationToken cancellationToken) =>
        {
            string principalId = PrincipalId(context, options);
            RequireValue(request.Question, nameof(request.Question));
            SupportAnswer answer = await assistant.AskAsync(
                principalId,
                conversationId,
                request.Question.Trim(),
                cancellationToken);
            return Results.Ok(answer);
        });

        app.MapPost("/conversations/{conversationId}/feedback", async (
            HttpContext context,
            string conversationId,
            FeedbackRequest request,
            CancellationToken cancellationToken) =>
        {
            string principalId = PrincipalId(context, options);
            RequireValue(request.ResponseId, nameof(request.ResponseId));
            RequireValue(request.Rating, nameof(request.Rating));
            await assistant.RecordFeedbackAsync(
                principalId,
                conversationId,
                request.ResponseId.Trim(),
                request.Rating.Trim(),
                request.Comment?.Trim(),
                cancellationToken);
            return Results.Json(
                new { status = "recorded" },
                statusCode: StatusCodes.Status201Created);
        });

        app.MapGet("/admin/unresolved", async (
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            string principalId = PrincipalId(context, options);
            RequireAdministrator(principalId, options);
            return Results.Ok(new
            {
                items = await assistant.ListUnresolvedAsync(cancellationToken)
            });
        });

        app.MapPost("/admin/evaluations", (
            HttpContext context,
            CancellationToken ignoredCancellationToken) =>
        {
            string principalId = PrincipalId(context, options);
            RequireAdministrator(principalId, options);
            string operationId = Guid.NewGuid().ToString("N");
            operations[operationId] = new OperationRecord("running");
            _ = RunEvaluationAsync(
                operationId,
                assistant,
                options.EvaluationDataset,
                operations,
                app.Logger,
                app.Lifetime.ApplicationStopping);
            return Results.Accepted(
                $"/admin/operations/{operationId}",
                new { operationId });
        });

        app.MapGet("/admin/operations/{operationId}", (
            HttpContext context,
            string operationId) =>
        {
            string principalId = PrincipalId(context, options);
            RequireAdministrator(principalId, options);
            return operations.TryGetValue(operationId, out OperationRecord? item)
                ? Results.Ok(item)
                : Results.NotFound(new { error = "Operation not found." });
        });

        app.MapDelete("/admin/resources", async (
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            string principalId = PrincipalId(context, options);
            RequireAdministrator(principalId, options);
            if (operations.Values.Any(item => item.Status == "running"))
            {
                return Results.Conflict(new
                {
                    error = "Wait for active evaluations before cleanup."
                });
            }

            await assistant.CleanupAsync(cancellationToken);
            return Results.Ok(new { status = "deleted" });
        });
    }

    private static async Task RunEvaluationAsync(
        string operationId,
        SupportAssistantService assistant,
        string datasetPath,
        ConcurrentDictionary<string, OperationRecord> operations,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        try
        {
            IReadOnlyList<EvaluationMetric> result =
                await assistant.EvaluateAsync(
                    await LoadEvaluationCasesAsync(
                        datasetPath, cancellationToken),
                    cancellationToken);
            operations[operationId] =
                new OperationRecord("completed", result);
        }
        catch (Exception error) when (
            error is AggregateException or AuthenticationFailedException or
            FoundryHttpException or HttpRequestException or IOException or
            InvalidOperationException or JsonException or
            OperationCanceledException or RequestFailedException or
            SupportAssistantException or TimeoutException)
        {
            logger.LogError(error, "Evaluation {OperationId} failed", operationId);
            operations[operationId] =
                new OperationRecord("failed", Error: error.Message);
        }
    }

    private static async Task<IReadOnlyList<EvaluationCase>>
        LoadEvaluationCasesAsync(
            string path,
            CancellationToken cancellationToken)
    {
        List<EvaluationCase> cases = [];
        int lineNumber = 0;
        await foreach (string line in File.ReadLinesAsync(path, cancellationToken))
        {
            lineNumber++;
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            using JsonDocument document = JsonDocument.Parse(line);
            JsonElement root = document.RootElement;
            try
            {
                cases.Add(new EvaluationCase(
                    root.GetProperty("id").GetString()
                        ?? throw new JsonException("id is required."),
                    root.GetProperty("query").GetString()
                        ?? throw new JsonException("query is required."),
                    root.GetProperty("groundTruth").GetString()
                        ?? throw new JsonException(
                            "groundTruth is required.")));
            }
            catch (Exception error) when (
                error is KeyNotFoundException or InvalidOperationException or
                JsonException)
            {
                throw new InvalidDataException(
                    $"Invalid evaluation case at {path}:{lineNumber}.",
                    error);
            }
        }

        return cases.Count > 0
            ? cases
            : throw new InvalidDataException(
                $"Evaluation dataset is empty: {path}");
    }

    private static string PrincipalId(
        HttpContext context,
        ApiOptions options)
    {
        string? principalId =
            context.Request.Headers["X-MS-CLIENT-PRINCIPAL-ID"]
                .FirstOrDefault();
        if (!options.RequireAuthentication)
        {
            return string.IsNullOrWhiteSpace(principalId)
                ? "test-user"
                : principalId.Trim();
        }

        return !string.IsNullOrWhiteSpace(principalId)
            ? principalId.Trim()
            : throw new BadHttpRequestException(
                "Microsoft Entra authentication is required.",
                StatusCodes.Status401Unauthorized);
    }

    private static void RequireAdministrator(
        string principalId,
        ApiOptions options)
    {
        if (!options.AdminPrincipalIds.Contains(principalId))
        {
            throw new BadHttpRequestException(
                "Administrator access is required.",
                StatusCodes.Status403Forbidden);
        }
    }

    private static void RequireValue(string value, string name)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new BadHttpRequestException(
                $"{name} is required.",
                StatusCodes.Status400BadRequest);
        }
    }
}
