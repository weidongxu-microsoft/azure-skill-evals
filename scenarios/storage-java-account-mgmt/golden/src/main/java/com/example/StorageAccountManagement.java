package com.example;

import com.azure.core.exception.HttpResponseException;
import com.azure.core.management.AzureEnvironment;
import com.azure.core.management.exception.ManagementException;
import com.azure.core.management.profile.AzureProfile;
import com.azure.identity.DefaultAzureCredential;
import com.azure.identity.DefaultAzureCredentialBuilder;
import com.azure.resourcemanager.storage.StorageManager;
import com.azure.resourcemanager.storage.models.BlobServiceProperties;
import com.azure.resourcemanager.storage.models.StorageAccount;
import com.azure.resourcemanager.storage.models.StorageAccountSkuType;

public final class StorageAccountManagement {
    private StorageAccountManagement() {
    }

    public static void main(String[] args) {
        String subscriptionId = requireEnvironment("AZURE_SUBSCRIPTION_ID");
        String resourceGroupName = requireEnvironment("RESOURCE_GROUP_NAME");
        String accountName =
                requireEnvironment("AZURE_STORAGE_ACCOUNT_NAME");

        DefaultAzureCredential credential =
                new DefaultAzureCredentialBuilder().build();
        AzureProfile profile = new AzureProfile(
                null, subscriptionId, AzureEnvironment.AZURE);
        StorageManager storageManager =
                StorageManager.authenticate(credential, profile);

        try {
            StorageAccount created = storageManager.storageAccounts()
                    .define(accountName)
                    .withRegion("eastus")
                    .withExistingResourceGroup(resourceGroupName)
                    .withSku(StorageAccountSkuType.STANDARD_LRS)
                    .withGeneralPurposeAccountKindV2()
                    .create();
            System.out.printf(
                    "Created storage account %s in %s with SKU %s%n",
                    created.name(),
                    created.regionName(),
                    created.skuType());

            for (StorageAccount account : storageManager.storageAccounts()
                    .listByResourceGroup(resourceGroupName)) {
                System.out.println("Storage account: " + account.name());
            }

            StorageAccount retrieved = storageManager.storageAccounts()
                    .getByResourceGroup(resourceGroupName, accountName);
            System.out.printf(
                    "Retrieved storage account: id=%s, region=%s, sku=%s, kind=%s%n",
                    retrieved.id(),
                    retrieved.regionName(),
                    retrieved.skuType(),
                    retrieved.kind());

            BlobServiceProperties blobService = storageManager.blobServices()
                    .getServicePropertiesAsync(resourceGroupName, accountName)
                    .block();
            BlobServiceProperties updatedBlobService = blobService.update()
                    .withBlobVersioningEnabled()
                    .apply();
            System.out.println(
                    "Blob versioning enabled: "
                            + updatedBlobService.isBlobVersioningEnabled());

            storageManager.storageAccounts()
                    .deleteByResourceGroup(resourceGroupName, accountName);
            System.out.println("Deleted storage account: " + accountName);
        } catch (ManagementException exception) {
            System.err.println(
                    "Storage management request failed: "
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
