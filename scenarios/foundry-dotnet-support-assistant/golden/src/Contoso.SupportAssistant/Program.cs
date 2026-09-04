using Azure.Core;
using Azure.Identity;
using Azure.Storage.Blobs;
using Contoso.SupportAssistant;

SupportSettings settings = SupportSettings.Load();
TokenCredential credential =
    Environment.GetEnvironmentVariable("AZURE_TOKEN_CREDENTIALS") == "prod"
        ? new ManagedIdentityCredential(
            new ManagedIdentityCredentialOptions())
        : new DefaultAzureCredential();
BlobServiceClient blobService = new(
    settings.StorageAccountEndpoint,
    credential);
BlobStateStore stateStore = new(
    blobService.GetBlobContainerClient(settings.StateContainer),
    settings.StateBlob);
await stateStore.InitializeAsync(CancellationToken.None);

using HttpClient httpClient = new();
FoundryRestGateway gateway = new(
    settings.ProjectEndpoint,
    credential,
    httpClient,
    settings.ModelDeploymentName,
    settings.EvaluationModelDeploymentName,
    settings.TokenScope);
SupportAssistantService assistant = new(gateway, stateStore);

WebApplicationBuilder builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{settings.Port}");
WebApplication app = builder.Build();
SupportApi.Map(
    app,
    assistant,
    new ApiOptions(
        true,
        settings.AdminPrincipalIds,
        settings.Materials,
        settings.EvaluationDataset));
await app.RunAsync();
