package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/resources/armresources"
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
	resourceGroupName, err := requiredEnvironment("AZURE_RESOURCE_GROUP")
	if err != nil {
		return err
	}

	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create default Azure credential: %w", err)
	}
	client, err := armresources.NewResourceGroupsClient(
		subscriptionID,
		credential,
		nil,
	)
	if err != nil {
		return fmt.Errorf("create resource groups client: %w", err)
	}

	created, err := client.CreateOrUpdate(
		ctx,
		resourceGroupName,
		armresources.ResourceGroup{Location: pointer("eastus")},
		nil,
	)
	if err != nil {
		return fmt.Errorf("create resource group: %w", err)
	}
	fmt.Printf("Created resource group: %s\n", value(created.Name))

	pager := client.NewListPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("list resource groups: %w", err)
		}
		for _, group := range page.Value {
			fmt.Println(value(group.Name))
		}
	}

	group, err := client.Get(ctx, resourceGroupName, nil)
	if err != nil {
		return fmt.Errorf("get resource group: %w", err)
	}
	fmt.Printf(
		"Resource group %s is in %s\n",
		value(group.Name),
		value(group.Location),
	)

	if _, err := client.CreateOrUpdate(
		ctx,
		resourceGroupName,
		armresources.ResourceGroup{
			Location: pointer("eastus"),
			Tags:     map[string]*string{"environment": pointer("example")},
		},
		nil,
	); err != nil {
		return fmt.Errorf("update resource group tags: %w", err)
	}

	poller, err := client.BeginDelete(ctx, resourceGroupName, nil)
	if err != nil {
		return fmt.Errorf("begin deleting resource group: %w", err)
	}
	if _, err := poller.PollUntilDone(ctx, nil); err != nil {
		return fmt.Errorf("delete resource group: %w", err)
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
