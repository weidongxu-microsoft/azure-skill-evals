package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
)

const (
	containerName = "my-container"
	blobName      = "hello.txt"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	accountURL, err := requiredEnvironment("AZURE_STORAGE_ACCOUNT_URL")
	if err != nil {
		return err
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create default Azure credential: %w", err)
	}
	client, err := azblob.NewClient(accountURL, credential, nil)
	if err != nil {
		return fmt.Errorf("create blob service client: %w", err)
	}

	if _, err := client.CreateContainer(ctx, containerName, nil); err != nil {
		return describeAzureError("create container", err)
	}
	if _, err := client.UploadBuffer(
		ctx,
		containerName,
		blobName,
		[]byte("Hello from Go"),
		nil,
	); err != nil {
		return describeAzureError("upload blob", err)
	}

	pager := client.NewListBlobsFlatPager(containerName, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return describeAzureError("list blobs", err)
		}
		for _, blob := range page.Segment.BlobItems {
			fmt.Println(value(blob.Name))
		}
	}

	download, err := client.DownloadStream(
		ctx,
		containerName,
		blobName,
		nil,
	)
	if err != nil {
		return describeAzureError("download blob", err)
	}
	content, readErr := io.ReadAll(download.Body)
	closeErr := download.Body.Close()
	if readErr != nil {
		return fmt.Errorf("read downloaded blob: %w", readErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close downloaded blob: %w", closeErr)
	}
	fmt.Println(string(content))

	if _, err := client.DeleteBlob(ctx, containerName, blobName, nil); err != nil {
		return describeAzureError("delete blob", err)
	}
	if _, err := client.DeleteContainer(ctx, containerName, nil); err != nil {
		return describeAzureError("delete container", err)
	}
	return nil
}

func describeAzureError(operation string, err error) error {
	var responseError *azcore.ResponseError
	if errors.As(err, &responseError) {
		return fmt.Errorf(
			"%s failed (status %d, code %s): %w",
			operation,
			responseError.StatusCode,
			responseError.ErrorCode,
			err,
		)
	}
	return fmt.Errorf("%s failed: %w", operation, err)
}

func requiredEnvironment(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s must be set", name)
	}
	return value, nil
}

func value[T any](pointer *T) T {
	if pointer == nil {
		var zero T
		return zero
	}
	return *pointer
}
