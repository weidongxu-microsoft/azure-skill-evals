using Azure;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Storage;
using Azure.ResourceManager.Storage.Models;
using System;
using System.Threading;

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
var armClient = new ArmClient(credential, subscriptionId);

try
{
    SubscriptionResource subscription =
        await armClient.GetDefaultSubscriptionAsync();
    ResourceGroupCollection resourceGroups = subscription.GetResourceGroups();
    ResourceGroupResource resourceGroup =
        (await resourceGroups.GetAsync(resourceGroupName)).Value;
    StorageAccountCollection accounts = resourceGroup.GetStorageAccounts();

    var sku = new StorageSku(StorageSkuName.StandardLrs);
    var content = new StorageAccountCreateOrUpdateContent(
        sku,
        StorageKind.StorageV2,
        location);
    using var timeout =
        new CancellationTokenSource(TimeSpan.FromMinutes(2));

    ArmOperation<StorageAccountResource> createOperation =
        await accounts.CreateOrUpdateAsync(
            WaitUntil.Started,
            accountName,
            content);

    while (!createOperation.HasCompleted)
    {
        await Task.Delay(TimeSpan.FromSeconds(2), timeout.Token);
        await createOperation.UpdateStatusAsync(timeout.Token);
        Console.WriteLine(
            $"Create status {createOperation.GetRawResponse().Status}; " +
            $"completed={createOperation.HasCompleted}.");
    }

    Response<StorageAccountResource> completion =
        await createOperation.WaitForCompletionAsync(timeout.Token);
    StorageAccountResource createdAccount = completion.Value;
    Console.WriteLine(
        $"Created {createdAccount.Data.Name} in " +
        $"{createdAccount.Data.Location}.");
}
catch (OperationCanceledException exception)
{
    Console.Error.WriteLine(
        $"Storage account creation timed out: {exception.Message}");
    Environment.ExitCode = 1;
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Storage account creation failed " +
        $"({exception.Status}, {exception.ErrorCode}): {exception.Message}");
    Environment.ExitCode = 1;
}
