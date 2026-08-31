using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Resources.Models;

return await RunAsync();

static async Task<int> RunAsync()
{
    try
    {
        string subscriptionId = GetRequiredEnvironmentVariable("AZURE_SUBSCRIPTION_ID");
        string resourceGroupName = GetRequiredEnvironmentVariable("AZURE_RESOURCE_GROUP_NAME");
        string location = Environment.GetEnvironmentVariable("AZURE_LOCATION") ?? "eastus";

        var credential = new DefaultAzureCredential();
        var armClient = new ArmClient(credential, subscriptionId);
        SubscriptionResource subscription = await armClient.GetDefaultSubscriptionAsync();
        ResourceGroupCollection resourceGroups = subscription.GetResourceGroups();

        var resourceGroupData = new ResourceGroupData(new AzureLocation(location));
        ArmOperation<ResourceGroupResource> createOperation =
            await resourceGroups.CreateOrUpdateAsync(
                WaitUntil.Completed,
                resourceGroupName,
                resourceGroupData);
        ResourceGroupResource createdResourceGroup = createOperation.Value;

        await foreach (ResourceGroupResource resourceGroup in resourceGroups.GetAllAsync())
        {
            Console.WriteLine(resourceGroup.Data.Name);
        }

        ResourceGroupResource retrievedResourceGroup =
            (await resourceGroups.GetAsync(resourceGroupName)).Value;
        Console.WriteLine(
            $"Retrieved resource group location: {retrievedResourceGroup.Data.Location}");

        var patch = new ResourceGroupPatch();
        patch.Tags.Add("environment", "development");
        ResourceGroupResource updatedResourceGroup =
            (await retrievedResourceGroup.UpdateAsync(patch)).Value;
        Console.WriteLine(
            $"Applied environment tag: {updatedResourceGroup.Data.Tags["environment"]}");

        await updatedResourceGroup.DeleteAsync(WaitUntil.Completed);
        Console.WriteLine($"Deleted resource group '{createdResourceGroup.Data.Name}'.");

        return 0;
    }
    catch (RequestFailedException ex)
    {
        Console.Error.WriteLine(
            $"Azure request failed with status {ex.Status}, error code " +
            $"'{ex.ErrorCode ?? "unknown"}': {ex.Message}");
        return 1;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Application failed: {ex}");
        return 1;
    }
}

static string GetRequiredEnvironmentVariable(string name)
{
    string? value = Environment.GetEnvironmentVariable(name);
    if (string.IsNullOrWhiteSpace(value))
    {
        throw new InvalidOperationException(
            $"Required environment variable '{name}' is not set.");
    }

    return value;
}
