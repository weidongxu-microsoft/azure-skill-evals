using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

internal static class Program
{
    private const string RecoverEnvironmentVariable = "RECOVER_SOFT_DELETED_SECRET";
    private const string PurgeEnvironmentVariable = "PURGE_DELETED_SECRET";
    private const string SecretValueEnvironmentVariable = "SECRET_VALUE";

    public static async Task<int> Main()
    {
        if (!Uri.TryCreate(Environment.GetEnvironmentVariable("KEY_VAULT_URI"), UriKind.Absolute, out Uri? vaultUri))
        {
            Console.Error.WriteLine(
                "Set KEY_VAULT_URI to an absolute vault URI, for example https://my-vault.vault.azure.net/.");
            return 2;
        }

        string secretName = Environment.GetEnvironmentVariable("SECRET_NAME") ?? "error-handling-demo";
        string? secretValue = Environment.GetEnvironmentVariable(SecretValueEnvironmentVariable);

        var options = new SecretClientOptions
        {
            Retry =
            {
                Mode = RetryMode.Exponential,
                Delay = TimeSpan.FromSeconds(0.8),
                MaxDelay = TimeSpan.FromSeconds(8),
                MaxRetries = 5,
                NetworkTimeout = TimeSpan.FromSeconds(30)
            }
        };

        var client = new SecretClient(vaultUri, new DefaultAzureCredential(), options);

        Console.WriteLine($"Vault: {vaultUri}");
        Console.WriteLine($"Secret: {secretName}");
        Console.WriteLine(
            "Retry policy: bounded exponential backoff, at most 5 retries, 0.8 second base delay, " +
            "8 second maximum delay, and 30 second network timeout. The Azure SDK honors the " +
            "service Retry-After header for 429 responses when present.");

        await ReadAndUpdateSecretAsync(client, secretName);

        if (secretValue is not null)
        {
            await SetSecretAsync(client, secretName, secretValue);
        }
        else
        {
            Console.WriteLine(
                $"Set {SecretValueEnvironmentVariable} to exercise SetSecretAsync; its value is never logged.");
        }

        if (IsEnabled(RecoverEnvironmentVariable))
        {
            await RecoverSecretAsync(client, secretName);
        }

        if (IsEnabled(PurgeEnvironmentVariable))
        {
            await PurgeSecretAsync(client, secretName);
        }

        return 0;
    }

    private static async Task ReadAndUpdateSecretAsync(SecretClient client, string secretName)
    {
        try
        {
            KeyVaultSecret secret = (await client.GetSecretAsync(secretName)).Value;
            Console.WriteLine($"Read current version {secret.Properties.Version}.");

            secret.Properties.Tags["error-handling-demo-last-run"] = DateTimeOffset.UtcNow.ToString("O");
            await client.UpdateSecretPropertiesAsync(secret.Properties);
            Console.WriteLine("Updated the current version's properties using its ETag.");
        }
        catch (RequestFailedException exception) when (exception.Status == 404)
        {
            ReportFailure("GetSecret/UpdateSecretProperties", exception);
            await DiagnoseMissingSecretAsync(client, secretName);
        }
        catch (RequestFailedException exception) when (exception.Status == 409)
        {
            ReportFailure("UpdateSecretProperties", exception);
            DiagnoseConflict(exception);
        }
        catch (RequestFailedException exception) when (exception.Status == 403)
        {
            ReportFailure("GetSecret/UpdateSecretProperties", exception);
            DiagnoseAuthorizationFailure(exception);
        }
        catch (RequestFailedException exception) when (exception.Status == 429)
        {
            ReportFailure("GetSecret/UpdateSecretProperties", exception);
            ExplainThrottling();
        }
        catch (RequestFailedException exception)
        {
            ReportFailure("GetSecret/UpdateSecretProperties", exception);
        }
    }

    private static async Task SetSecretAsync(SecretClient client, string secretName, string secretValue)
    {
        try
        {
            KeyVaultSecret created = (await client.SetSecretAsync(secretName, secretValue)).Value;
            Console.WriteLine($"Set a new secret version {created.Properties.Version}.");
        }
        catch (RequestFailedException exception) when (exception.Status == 409)
        {
            ReportFailure("SetSecret", exception);
            DiagnoseConflict(exception);

            if (IsSoftDeletedNameConflict(exception))
            {
                await DiagnoseMissingSecretAsync(client, secretName);
            }
        }
        catch (RequestFailedException exception) when (exception.Status == 403)
        {
            ReportFailure("SetSecret", exception);
            DiagnoseAuthorizationFailure(exception);
        }
        catch (RequestFailedException exception) when (exception.Status == 429)
        {
            ReportFailure("SetSecret", exception);
            ExplainThrottling();
        }
        catch (RequestFailedException exception)
        {
            ReportFailure("SetSecret", exception);
        }
    }

    private static async Task DiagnoseMissingSecretAsync(SecretClient client, string secretName)
    {
        try
        {
            DeletedSecret? match = null;

            await foreach (DeletedSecret deletedSecret in client.GetDeletedSecretsAsync())
            {
                if (string.Equals(deletedSecret.Name, secretName, StringComparison.OrdinalIgnoreCase))
                {
                    match = deletedSecret;
                    break;
                }
            }

            if (match is null)
            {
                Console.WriteLine(
                    $"'{secretName}' is absent from both active secrets and the deleted-secrets collection.");
                return;
            }

            Console.WriteLine(
                $"'{secretName}' is soft-deleted and recoverable. Recovery ID: {match.RecoveryId}. " +
                $"Set {RecoverEnvironmentVariable}=true to call RecoverDeletedSecretAsync.");
        }
        catch (RequestFailedException exception) when (exception.Status == 403)
        {
            ReportFailure("GetDeletedSecrets", exception);
            Console.WriteLine(
                "The identity also needs permission to list deleted secrets before a 404 can be classified.");
            DiagnoseAuthorizationFailure(exception);
        }
        catch (RequestFailedException exception) when (exception.Status == 429)
        {
            ReportFailure("GetDeletedSecrets", exception);
            ExplainThrottling();
        }
        catch (RequestFailedException exception)
        {
            ReportFailure("GetDeletedSecrets", exception);
        }
    }

    private static async Task RecoverSecretAsync(SecretClient client, string secretName)
    {
        try
        {
            RecoverDeletedSecretOperation operation = await client.StartRecoverDeletedSecretAsync(secretName);
            await operation.WaitForCompletionAsync();
            Console.WriteLine($"Recovered '{secretName}'.");
        }
        catch (RequestFailedException exception) when (exception.Status == 409)
        {
            ReportFailure("RecoverDeletedSecret", exception);
            DiagnoseConflict(exception);
        }
        catch (RequestFailedException exception) when (exception.Status == 403)
        {
            ReportFailure("RecoverDeletedSecret", exception);
            DiagnoseAuthorizationFailure(exception);
        }
        catch (RequestFailedException exception) when (exception.Status == 429)
        {
            ReportFailure("RecoverDeletedSecret", exception);
            ExplainThrottling();
        }
        catch (RequestFailedException exception)
        {
            ReportFailure("RecoverDeletedSecret", exception);
        }
    }

    private static async Task PurgeSecretAsync(SecretClient client, string secretName)
    {
        Console.WriteLine(
            $"Purging '{secretName}' is irreversible. The operation was explicitly enabled with " +
            $"{PurgeEnvironmentVariable}=true.");

        try
        {
            await client.PurgeDeletedSecretAsync(secretName);
            Console.WriteLine($"Purge request for '{secretName}' was accepted.");
        }
        catch (RequestFailedException exception) when (IsPurgeProtectionFailure(exception))
        {
            ReportFailure("PurgeDeletedSecret", exception);
            Console.WriteLine(
                "Purge protection prevents manual purge during the retention period. It cannot be disabled " +
                "after it is enabled; wait for the retention period to expire.");
        }
        catch (RequestFailedException exception) when (exception.Status == 403)
        {
            ReportFailure("PurgeDeletedSecret", exception);
            DiagnoseAuthorizationFailure(exception);
        }
        catch (RequestFailedException exception) when (exception.Status == 404)
        {
            ReportFailure("PurgeDeletedSecret", exception);
            Console.WriteLine("The name is not currently present in the deleted-secrets collection.");
        }
        catch (RequestFailedException exception) when (exception.Status == 409)
        {
            ReportFailure("PurgeDeletedSecret", exception);
            DiagnoseConflict(exception);
        }
        catch (RequestFailedException exception) when (exception.Status == 429)
        {
            ReportFailure("PurgeDeletedSecret", exception);
            ExplainThrottling();
        }
        catch (RequestFailedException exception)
        {
            ReportFailure("PurgeDeletedSecret", exception);
        }
    }

    private static void DiagnoseAuthorizationFailure(RequestFailedException exception)
    {
        string details = $"{exception.ErrorCode} {exception.Message}";

        if (ContainsAny(details, "ForbiddenByRbac", "DeniedWithNoValidRBAC", "Assignment:"))
        {
            Console.WriteLine(
                "The response identifies the vault's Azure RBAC authorization path. Assign a suitable " +
                "Key Vault data-plane role (for example, Key Vault Secrets User or Key Vault Secrets Officer) " +
                "at the vault or parent scope, then allow time for role propagation.");
        }
        else if (ContainsAny(details, "access policy", "does not have secrets"))
        {
            Console.WriteLine(
                "The response identifies the legacy access-policy authorization path. Add the required secret " +
                "permissions to this identity in the vault's Access policies; Azure RBAC data-plane roles do " +
                "not grant access while the vault uses legacy policies.");
        }
        else
        {
            Console.WriteLine(
                "Check the vault's Access configuration. For Azure RBAC, inspect data-plane role assignments " +
                "and propagation. For the legacy model, inspect the identity's secret permissions under Access " +
                "policies. Also check firewall/private-endpoint restrictions because they can return 403.");
        }
    }

    private static void DiagnoseConflict(RequestFailedException exception)
    {
        if (IsSoftDeletedNameConflict(exception))
        {
            Console.WriteLine(
                "The name belongs to a soft-deleted recoverable secret. Recover it or purge it (only when purge " +
                "protection and authorization permit) before attempting to create the name again.");
            return;
        }

        Console.WriteLine(
            "This is a version or concurrent-update conflict. Re-read the current secret/version and retry the " +
            "intended update with its current ETag; do not blindly overwrite another writer's change.");
    }

    private static void ExplainThrottling()
    {
        Console.WriteLine(
            "The service throttled the request. SecretClient already applied the configured bounded exponential " +
            "retry policy and honored Retry-After when supplied. This final 429 means the retry budget was " +
            "exhausted; reduce request rate or retry the higher-level operation later.");
    }

    private static bool IsSoftDeletedNameConflict(RequestFailedException exception)
    {
        string details = $"{exception.ErrorCode} {exception.Message}";
        return ContainsAny(details, "ObjectIsDeletedButRecoverable", "deleted but recoverable", "soft-deleted");
    }

    private static bool IsPurgeProtectionFailure(RequestFailedException exception)
    {
        if (exception.Status is not (403 or 409))
        {
            return false;
        }

        string details = $"{exception.ErrorCode} {exception.Message}";
        return ContainsAny(details, "purge protection", "purge-protected", "PurgeProtected");
    }

    private static void ReportFailure(string operation, RequestFailedException exception)
    {
        Console.Error.WriteLine(
            $"{operation} failed: HTTP Status={exception.Status}, ErrorCode={exception.ErrorCode ?? "<none>"}.");
    }

    private static bool ContainsAny(string value, params string[] candidates) =>
        candidates.Any(candidate => value.Contains(candidate, StringComparison.OrdinalIgnoreCase));

    private static bool IsEnabled(string name) =>
        string.Equals(Environment.GetEnvironmentVariable(name), "true", StringComparison.OrdinalIgnoreCase);
}
