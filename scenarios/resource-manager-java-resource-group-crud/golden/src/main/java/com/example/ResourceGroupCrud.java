package com.example;

import com.azure.core.exception.HttpResponseException;
import com.azure.core.management.AzureEnvironment;
import com.azure.core.management.exception.ManagementException;
import com.azure.core.management.profile.AzureProfile;
import com.azure.identity.DefaultAzureCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.resourcemanager.AzureResourceManager;
import com.azure.resourcemanager.resources.models.ResourceGroup;

public final class ResourceGroupCrud {
    private ResourceGroupCrud() {
    }

    public static void main(String[] args) {
        String subscriptionId = requireEnvironment("AZURE_SUBSCRIPTION_ID");
        String resourceGroupName = requireEnvironment("RESOURCE_GROUP_NAME");
        String location = requireEnvironment("AZURE_LOCATION");

        DefaultAzureCredential credential =
                new DefaultAzureCredentialBuilder().build();
        AzureProfile profile = new AzureProfile(AzureEnvironment.AZURE);
        AzureResourceManager azure = AzureResourceManager
                .authenticate(credential, profile)
                .withSubscription(subscriptionId);

        try {
            ResourceGroup created = azure.resourceGroups()
                    .define(resourceGroupName)
                    .withRegion(location)
                    .create();
            System.out.println("Created resource group: " + created.name());

            for (ResourceGroup group : azure.resourceGroups().list()) {
                System.out.println(
                        "Resource group: " + group.name() + " " + group.id());
            }

            ResourceGroup retrieved =
                    azure.resourceGroups().getByName(resourceGroupName);
            System.out.println("Retrieved resource group: " + retrieved.id());

            ResourceGroup updated = retrieved.update()
                    .withTag("environment", "development")
                    .apply();
            System.out.println("Updated resource group tags: " + updated.tags());

            azure.resourceGroups().deleteByName(resourceGroupName);
            System.out.println("Deleted resource group: " + resourceGroupName);
        } catch (ManagementException exception) {
            System.err.println(
                    "Resource management request failed: "
                            + exception.getMessage());
            throw exception;
        } catch (HttpResponseException exception) {
            System.err.println(
                    "Azure request failed: " + exception.getMessage());
            throw exception;
        }
    }

    private static String requireEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(
                    "Set " + name + " before running.");
        }
        return value;
    }
}
