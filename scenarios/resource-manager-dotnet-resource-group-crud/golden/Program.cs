using Azure;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Resources.Models;

string subscriptionId =
    Environment.GetEnvironmentVariable("AZURE_SUBSCRIPTION_ID")
    ?? throw new InvalidOperationException(
        "Set AZURE_SUBSCRIPTION_ID before running.");
string resourceGroupName =
    Environment.GetEnvironmentVariable("AZURE_RESOURCE_GROUP_NAME")
    ?? throw new InvalidOperationException(
        "Set AZURE_RESOURCE_GROUP_NAME before running.");
string location =
    Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus";

var client = new ArmClient(
    new DefaultAzureCredential(),
    subscriptionId);
SubscriptionResource subscription =
    await client.GetDefaultSubscriptionAsync();
ResourceGroupCollection groups = subscription.GetResourceGroups();

try
{
    var data = new ResourceGroupData(location);
    ArmOperation<ResourceGroupResource> createOperation =
        await groups.CreateOrUpdateAsync(
            WaitUntil.Completed,
            resourceGroupName,
            data);
    ResourceGroupResource created = createOperation.Value;
    Console.WriteLine(
        $"Created {created.Data.Name} in {created.Data.Location}.");

    await foreach (ResourceGroupResource item in groups.GetAllAsync())
    {
        Console.WriteLine($"Resource group: {item.Data.Name}");
    }

    ResourceGroupResource resourceGroup =
        (await groups.GetAsync(resourceGroupName)).Value;
    Console.WriteLine(
        $"Retrieved {resourceGroup.Data.Name} in {resourceGroup.Data.Location}.");

    var patch = new ResourceGroupPatch();
    patch.Tags.Add("environment", "development");
    ResourceGroupResource updated =
        (await resourceGroup.UpdateAsync(patch)).Value;
    string appliedEnvironment = updated.Data.Tags["environment"];
    Console.WriteLine(appliedEnvironment);

    await updated.DeleteAsync(WaitUntil.Completed);
    Console.WriteLine($"Deleted resource group {resourceGroupName}.");
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Azure Resource Manager request failed " +
        $"({exception.Status}, {exception.ErrorCode}): {exception.Message}");
    Environment.ExitCode = 1;
}
