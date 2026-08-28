using Azure;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Storage;
using Azure.ResourceManager.Storage.Models;

string subscriptionId =
    Environment.GetEnvironmentVariable("AZURE_SUBSCRIPTION_ID")
    ?? throw new InvalidOperationException(
        "Set AZURE_SUBSCRIPTION_ID before running.");
string resourceGroupName =
    Environment.GetEnvironmentVariable("AZURE_RESOURCE_GROUP_NAME")
    ?? throw new InvalidOperationException(
        "Set AZURE_RESOURCE_GROUP_NAME before running.");
string accountName =
    Environment.GetEnvironmentVariable("AZURE_STORAGE_ACCOUNT_NAME")
    ?? throw new InvalidOperationException(
        "Set AZURE_STORAGE_ACCOUNT_NAME before running.");
string location =
    Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus";

var credential = new DefaultAzureCredential();
var client = new ArmClient(credential, subscriptionId);

try
{
    SubscriptionResource subscription =
        await client.GetDefaultSubscriptionAsync();
    ResourceGroupCollection resourceGroups = subscription.GetResourceGroups();
    ResourceGroupResource resourceGroup =
        (await resourceGroups.GetAsync(resourceGroupName)).Value;
    StorageAccountCollection accounts = resourceGroup.GetStorageAccounts();

    var content = new StorageAccountCreateOrUpdateContent(
        new StorageSku(StorageSkuName.StandardLrs),
        StorageKind.StorageV2,
        location);
    ArmOperation<StorageAccountResource> createOperation =
        await accounts.CreateOrUpdateAsync(
            WaitUntil.Completed,
            accountName,
            content);
    StorageAccountResource created = createOperation.Value;
    Console.WriteLine($"Created {created.Data.Name}.");

    await foreach (StorageAccountResource item in accounts.GetAllAsync())
    {
        Console.WriteLine($"Storage account: {item.Data.Name}");
    }

    StorageAccountResource retrieved =
        (await accounts.GetAsync(accountName)).Value;
    Console.WriteLine(
        $"Retrieved {retrieved.Data.Name} in {retrieved.Data.Location}.");

    BlobServiceResource blobService = retrieved.GetBlobService();
    var blobData = new BlobServiceData()
    {
        IsVersioningEnabled = true,
    };
    ArmOperation<BlobServiceResource> blobOperation =
        await blobService.CreateOrUpdateAsync(
            WaitUntil.Completed,
            blobData);
    BlobServiceResource configuredBlobService = blobOperation.Value;
    Console.WriteLine(
        $"Versioning enabled: " +
        $"{configuredBlobService.Data.IsVersioningEnabled}.");

    await retrieved.DeleteAsync(WaitUntil.Completed);
    Console.WriteLine($"Deleted storage account {accountName}.");
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Azure Storage management request failed " +
        $"({exception.Status}, {exception.ErrorCode}): {exception.Message}");
    Environment.ExitCode = 1;
}
