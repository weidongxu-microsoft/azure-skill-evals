using System.Text.Json.Serialization;
using Azure;

namespace Contoso.SupportAssistant;

public sealed record Citation(string FileId, string Filename);

public sealed record FoundryResources(
    string VectorStoreId,
    List<string> FileIds,
    string? AgentName = null,
    string? AgentVersion = null);

public sealed record SupportAnswer(
    string ConversationId,
    string ResponseId,
    string Text,
    List<Citation> Citations,
    bool Supported);

public sealed record GatewayAnswer(
    string ConversationId,
    string ResponseId,
    string Text,
    List<Citation> Citations,
    bool Supported,
    List<string> TurnItemIds,
    List<string> RetrievedContext);

public sealed record StoredAnswer(
    string EmployeeId,
    string LocalConversationId,
    string Question,
    string CreatedAt,
    string ConversationId,
    string ResponseId,
    string Text,
    List<Citation> Citations,
    bool Supported);

public sealed record UnresolvedQuestion(
    string EmployeeId,
    string LocalConversationId,
    string Question,
    string ResponseId,
    string CreatedAt);

public sealed record FeedbackRecord(
    string EmployeeId,
    string LocalConversationId,
    string ResponseId,
    string Rating,
    string? Comment,
    string CreatedAt);

public sealed record EvaluationCase(
    string Id,
    string Query,
    string GroundTruth);

public sealed record EvaluationMetric(
    string ItemId,
    string ItemStatus,
    string Name,
    double? Score,
    bool? Passed);

public sealed class AssistantState
{
    public int Version { get; init; } = 1;

    public FoundryResources? Resources { get; set; }

    public Dictionary<string, string> Conversations { get; init; } = [];

    public List<StoredAnswer> Answers { get; init; } = [];

    public List<UnresolvedQuestion> UnresolvedQuestions { get; init; } = [];

    public List<FeedbackRecord> Feedback { get; init; } = [];

    [JsonIgnore]
    public ETag? ETag { get; set; }

    [JsonIgnore]
    public bool Loaded { get; set; }
}
