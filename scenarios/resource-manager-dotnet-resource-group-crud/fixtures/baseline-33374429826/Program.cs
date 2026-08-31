using Azure;
using Azure.Core;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.Resources;
using Azure.ResourceManager.Resources.Models;

internal static class Program
{
    private static async Task<int> Main()
    {
        try
        {
            string subscriptionId = GetRequiredEnvironmentVariable("AZURE_SUBSCRIPTION_ID");
            string resourceGroupName = GetRequiredEnvironmentVariable("AZURE_RESOURCE_GROUP_NAME");
            string location = Environment.GetEnvironmentVariable("AZURE_LOCATION") is { Length: > 0 } configuredLocation
                ? configuredLocation
                : "eastus";

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

            Console.WriteLine($"Created or updated resource group '{createOperation.Value.Data.Name}'.");

            await foreach (ResourceGroupResource listedResourceGroup in resourceGroups.GetAllAsync())
            {
                Console.WriteLine(listedResourceGroup.Data.Name);
            }

            Response<ResourceGroupResource> getResponse =
                await resourceGroups.GetAsync(resourceGroupName);
            ResourceGroupResource resourceGroup = getResponse.Value;
            Console.WriteLine(
                $"Retrieved resource group '{resourceGroup.Data.Name}' in '{resourceGroup.Data.Location}'.");

            var patch = new ResourceGroupPatch();
            patch.Tags["environment"] = "development";
            Response<ResourceGroupResource> updateResponse = await resourceGroup.UpdateAsync(patch);
            Console.WriteLine(
                $"Applied environment tag: {updateResponse.Value.Data.Tags["environment"]}");

            ArmOperation deleteOperation = await resourceGroup.DeleteAsync(WaitUntil.Completed);
            await deleteOperation.WaitForCompletionResponseAsync();
            Console.WriteLine($"Deleted resource group '{resourceGroupName}'.");

            return 0;
        }
        catch (RequestFailedException exception)
        {
            Console.Error.WriteLine(
                $"Azure request failed with status {exception.Status}, " +
                $"error code '{exception.ErrorCode ?? "unknown"}': {exception.Message}");
            return 1;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"Resource group lifecycle failed: {exception}");
            return 1;
        }
    }

    private static string GetRequiredEnvironmentVariable(string name)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException(
                $"Required environment variable {name} is not set or is empty.");
        }

        return value;
    }
}
