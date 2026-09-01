package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	subscriptionID, err := requiredEnvironment("AZURE_SUBSCRIPTION_ID")
	if err != nil {
		return err
	}
	resourceGroup, err := requiredEnvironment("AZURE_RESOURCE_GROUP")
	if err != nil {
		return err
	}
	accountName, err := requiredEnvironment("AZURE_STORAGE_ACCOUNT_NAME")
	if err != nil {
		return err
	}

	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create default Azure credential: %w", err)
	}
	client, err := armstorage.NewAccountsClient(subscriptionID, credential, nil)
	if err != nil {
		return fmt.Errorf("create storage accounts client: %w", err)
	}

	poller, err := client.BeginCreate(
		ctx,
		resourceGroup,
		accountName,
		armstorage.AccountCreateParameters{
			Kind:     pointer(armstorage.KindStorageV2),
			Location: pointer("eastus"),
			SKU: &armstorage.SKU{
				Name: pointer(armstorage.SKUNameStandardLRS),
			},
		},
		nil,
	)
	if err != nil {
		return fmt.Errorf("begin creating storage account: %w", err)
	}
	if _, err := poller.PollUntilDone(ctx, nil); err != nil {
		return fmt.Errorf("create storage account: %w", err)
	}

	pager := client.NewListByResourceGroupPager(resourceGroup, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("list storage accounts: %w", err)
		}
		for _, account := range page.Value {
			fmt.Println(value(account.Name))
		}
	}

	account, err := client.GetProperties(
		ctx,
		resourceGroup,
		accountName,
		nil,
	)
	if err != nil {
		return fmt.Errorf("get storage account properties: %w", err)
	}
	fmt.Printf("Storage account ID: %s\n", value(account.ID))

	if _, err := client.Update(
		ctx,
		resourceGroup,
		accountName,
		armstorage.AccountUpdateParameters{
			Tags: map[string]*string{"environment": pointer("example")},
		},
		nil,
	); err != nil {
		return fmt.Errorf("update storage account: %w", err)
	}

	if _, err := client.Delete(ctx, resourceGroup, accountName, nil); err != nil {
		return fmt.Errorf("delete storage account: %w", err)
	}
	return nil
}

func requiredEnvironment(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s must be set", name)
	}
	return value, nil
}

func pointer[T any](value T) *T {
	return &value
}

func value[T any](pointer *T) T {
	if pointer == nil {
		var zero T
		return zero
	}
	return *pointer
}
