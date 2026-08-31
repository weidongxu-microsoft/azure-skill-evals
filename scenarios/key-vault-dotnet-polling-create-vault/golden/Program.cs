using Azure;
using Azure.Identity;
using Azure.ResourceManager;
using Azure.ResourceManager.KeyVault;
using Azure.ResourceManager.KeyVault.Models;
using Azure.ResourceManager.Resources;
using Azure.Security.KeyVault.Secrets;

string subscriptionId =
    Environment.GetEnvironmentVariable("AZURE_SUBSCRIPTION_ID")
    ?? throw new InvalidOperationException(
        "Set AZURE_SUBSCRIPTION_ID before running.");
string resourceGroupName =
    Environment.GetEnvironmentVariable("AZURE_RESOURCE_GROUP_NAME")
    ?? throw new InvalidOperationException(
        "Set AZURE_RESOURCE_GROUP_NAME before running.");
string vaultName =
    Environment.GetEnvironmentVariable("AZURE_KEY_VAULT_NAME")
    ?? throw new InvalidOperationException(
        "Set AZURE_KEY_VAULT_NAME before running.");
Guid tenantId = Guid.Parse(
    Environment.GetEnvironmentVariable("AZURE_TENANT_ID")
    ?? throw new InvalidOperationException(
        "Set AZURE_TENANT_ID before running."));
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
    KeyVaultCollection vaults = resourceGroup.GetKeyVaults();

    var sku = new KeyVaultSku(
        KeyVaultSkuFamily.A,
        KeyVaultSkuName.Standard);
    var properties = new KeyVaultProperties(tenantId, sku)
    {
        EnableRbacAuthorization = true,
        EnableSoftDelete = true,
        EnablePurgeProtection = true,
    };
    var content = new KeyVaultCreateOrUpdateContent(location, properties);

    ArmOperation<KeyVaultResource> createOperation =
        await vaults.CreateOrUpdateAsync(
            WaitUntil.Started,
            vaultName,
            content);
    await createOperation.WaitForCompletionAsync();
    KeyVaultResource createdVault = createOperation.Value;

    var secretClient = new SecretClient(
        createdVault.Data.Properties.VaultUri,
        credential);

    Console.WriteLine(
        $"Created vault {createdVault.Data.Name} at {secretClient.VaultUri}.");
}
catch (RequestFailedException exception)
{
    Console.Error.WriteLine(
        $"Key Vault creation failed " +
        $"({exception.Status}, {exception.ErrorCode}): {exception.Message}");
    Environment.ExitCode = 1;
}
