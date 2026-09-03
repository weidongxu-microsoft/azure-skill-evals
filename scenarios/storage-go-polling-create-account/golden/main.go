package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/storage/armstorage"
)

func required(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func run(ctx context.Context) error {
	subscriptionID, err := required("AZURE_SUBSCRIPTION_ID")
	if err != nil {
		return err
	}
	resourceGroup, err := required("AZURE_RESOURCE_GROUP")
	if err != nil {
		return err
	}
	accountName, err := required("AZURE_STORAGE_ACCOUNT_NAME")
	if err != nil {
		return err
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create credential: %w", err)
	}
	client, err := armstorage.NewAccountsClient(subscriptionID, credential, nil)
	if err != nil {
		return fmt.Errorf("create accounts client: %w", err)
	}
	timeoutCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	poller, err := client.BeginCreate(timeoutCtx, resourceGroup, accountName, armstorage.AccountCreateParameters{
		Kind: pointer(armstorage.KindStorageV2), Location: pointer("eastus"), SKU: &armstorage.SKU{Name: pointer(armstorage.SKUNameStandardLRS)},
	}, nil)
	if err != nil {
		return fmt.Errorf("begin account creation: %w", err)
	}
	if os.Getenv("AZURE_LRO_MANUAL_POLL") == "true" {
		for !poller.Done() {
			response, err := poller.Poll(timeoutCtx)
			if err != nil {
				return fmt.Errorf("poll account creation: %w", err)
			}
			if response != nil {
				fmt.Println("poll status:", response.Status)
			}
			time.Sleep(2 * time.Second)
		}
		result, err := poller.Result(timeoutCtx)
		if err != nil {
			return fmt.Errorf("get account result: %w", err)
		}
		fmt.Println("created account:", value(result.Name))
		return nil
	}
	result, err := poller.PollUntilDone(timeoutCtx, nil)
	if err != nil {
		return fmt.Errorf("wait for account creation: %w", err)
	}
	fmt.Println("created account:", value(result.Name))
	return nil
}

func pointer[T any](value T) *T { return &value }
func value[T any](pointer *T) T {
	if pointer == nil {
		var zero T
		return zero
	}
	return *pointer
}

func main() {
	if err := run(context.Background()); err != nil {
		var responseError *azcore.ResponseError
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			fmt.Fprintln(os.Stderr, "storage account creation timed out")
		case errors.Is(err, context.Canceled):
			fmt.Fprintln(os.Stderr, "storage account creation canceled")
		case errors.As(err, &responseError):
			fmt.Fprintf(os.Stderr, "Azure request failed: status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
		default:
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
