namespace Contoso.SupportAssistant;

public sealed record SupportSettings(
    Uri ProjectEndpoint,
    string ModelDeploymentName,
    string EvaluationModelDeploymentName,
    Uri StorageAccountEndpoint,
    string StateContainer,
    string StateBlob,
    string TokenScope,
    HashSet<string> AdminPrincipalIds,
    int Port,
    string[] Materials,
    string EvaluationDataset)
{
    public static SupportSettings Load(
        IReadOnlyDictionary<string, string?>? environment = null)
    {
        environment ??= Environment.GetEnvironmentVariables()
            .Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(
                item => (string)item.Key,
                item => item.Value?.ToString(),
                StringComparer.OrdinalIgnoreCase);

        int port = int.Parse(Get(environment, "PORT", "3000"),
            System.Globalization.CultureInfo.InvariantCulture);
        if (port is < 1 or > 65535)
        {
            throw new InvalidOperationException(
                "PORT must be between 1 and 65535.");
        }

        HashSet<string> administrators = GetRequired(
            environment, "SUPPORT_ADMIN_PRINCIPAL_IDS")
            .Split(',', StringSplitOptions.RemoveEmptyEntries |
                StringSplitOptions.TrimEntries)
            .ToHashSet(StringComparer.Ordinal);
        if (administrators.Count == 0)
        {
            throw new InvalidOperationException(
                "SUPPORT_ADMIN_PRINCIPAL_IDS must contain an object ID.");
        }

        return new SupportSettings(
            new Uri(GetRequired(environment, "FOUNDRY_PROJECT_ENDPOINT")),
            GetRequired(environment, "MODEL_DEPLOYMENT_NAME"),
            GetRequired(environment, "EVALUATION_MODEL_DEPLOYMENT_NAME"),
            new Uri(GetRequired(environment, "STORAGE_ACCOUNT_ENDPOINT")),
            Get(environment, "SUPPORT_STATE_CONTAINER", "support-assistant"),
            Get(environment, "SUPPORT_STATE_BLOB", "state/application.json"),
            Get(environment, "FOUNDRY_TOKEN_SCOPE",
                "https://ai.azure.com/.default"),
            administrators,
            port,
            [
                Path.Combine("materials", "contoso-aero-300.md"),
                Path.Combine(
                    "materials", "contoso-aero-300-warranty.md")
            ],
            Path.Combine("evaluation", "support-cases.jsonl"));
    }

    private static string GetRequired(
        IReadOnlyDictionary<string, string?> environment,
        string name)
    {
        string value = Get(environment, name, string.Empty);
        return string.IsNullOrWhiteSpace(value)
            ? throw new InvalidOperationException($"{name} is required.")
            : value;
    }

    private static string Get(
        IReadOnlyDictionary<string, string?> environment,
        string name,
        string fallback) =>
        environment.TryGetValue(name, out string? value) &&
        !string.IsNullOrWhiteSpace(value)
            ? value.Trim()
            : fallback;
}
