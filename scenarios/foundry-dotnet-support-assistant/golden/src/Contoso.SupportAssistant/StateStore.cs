using System.Text.Json;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;

namespace Contoso.SupportAssistant;

public interface IStateStore
{
    Task<AssistantState> LoadAsync(CancellationToken cancellationToken);

    Task SaveAsync(
        AssistantState state,
        CancellationToken cancellationToken);
}

public sealed class BlobStateStore(
    BlobContainerClient container,
    string blobName) : IStateStore
{
    private static readonly JsonSerializerOptions JsonOptions =
        new(JsonSerializerDefaults.Web)
        {
            WriteIndented = true
        };

    private readonly BlobClient _blob = container.GetBlobClient(blobName);

    public async Task InitializeAsync(CancellationToken cancellationToken) =>
        await container.GetPropertiesAsync(cancellationToken: cancellationToken);

    public async Task<AssistantState> LoadAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            Response<BlobDownloadResult> response =
                await _blob.DownloadContentAsync(cancellationToken);
            AssistantState state =
                response.Value.Content.ToObjectFromJson<AssistantState>(
                    JsonOptions)
                ?? throw new InvalidDataException(
                    "The durable state blob contains invalid JSON.");
            if (state.Version != 1)
            {
                throw new InvalidDataException(
                    "The durable state version is not supported.");
            }

            state.ETag = response.Value.Details.ETag;
            state.Loaded = true;
            return state;
        }
        catch (RequestFailedException error) when (error.Status == 404)
        {
            return new AssistantState { Loaded = true };
        }
    }

    public async Task SaveAsync(
        AssistantState state,
        CancellationToken cancellationToken)
    {
        if (!state.Loaded)
        {
            throw new InvalidOperationException(
                "State must be loaded before it can be saved.");
        }

        BlobRequestConditions conditions = state.ETag is null
            ? new BlobRequestConditions { IfNoneMatch = ETag.All }
            : new BlobRequestConditions { IfMatch = state.ETag };
        BlobUploadOptions options = new()
        {
            Conditions = conditions,
            HttpHeaders = new BlobHttpHeaders
            {
                ContentType = "application/json"
            }
        };
        BinaryData content = BinaryData.FromObjectAsJson(state, JsonOptions);
        Response<BlobContentInfo> response =
            await _blob.UploadAsync(content, options, cancellationToken);
        state.ETag = response.Value.ETag;
    }
}
