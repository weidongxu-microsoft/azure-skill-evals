package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/service"
)

func run(ctx context.Context) error {
	endpoint := os.Getenv("AZURE_STORAGE_BLOB_ENDPOINT")
	if endpoint == "" {
		return errors.New("AZURE_STORAGE_BLOB_ENDPOINT is required, for example https://<account>.blob.core.windows.net/")
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create DefaultAzureCredential: %w", err)
	}
	client, err := service.NewClient(endpoint, credential, nil)
	if err != nil {
		return fmt.Errorf("create Blob service client: %w", err)
	}
	pager := client.NewListContainersPager(nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("list containers: %w", err)
		}
		for _, item := range page.ContainerItems {
			if item.Name != nil {
				fmt.Println(*item.Name)
			}
		}
	}
	return nil
}

func main() {
	if err := run(context.Background()); err != nil {
		var authenticationError *azidentity.AuthenticationFailedError
		var requiredError *azidentity.AuthenticationRequiredError
		var responseError *azcore.ResponseError
		switch {
		case errors.As(err, &authenticationError):
			fmt.Fprintf(os.Stderr, "Azure authentication failed: %v\n", authenticationError)
		case errors.As(err, &requiredError):
			fmt.Fprintf(os.Stderr, "no credential in the DefaultAzureCredential chain could satisfy the authentication request: %v\n", requiredError)
		case errors.As(err, &responseError):
			fmt.Fprintf(os.Stderr, "Blob service request failed: status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
		default:
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
