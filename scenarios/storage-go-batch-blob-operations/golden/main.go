package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/service"
)

const maxBatchOperations = 256

type operationFailure struct {
	Index    int
	BlobName string
	Err      error
}

type batchError struct {
	Failures []operationFailure
}

func (err *batchError) Error() string {
	return fmt.Sprintf("%d batch operations failed", len(err.Failures))
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	accountName, err := requiredEnvironment("AZURE_STORAGE_ACCOUNT_NAME")
	if err != nil {
		return err
	}
	accountKey, err := requiredEnvironment("AZURE_STORAGE_ACCOUNT_KEY")
	if err != nil {
		return err
	}
	accountURL, err := requiredEnvironment("AZURE_STORAGE_ACCOUNT_URL")
	if err != nil {
		return err
	}
	containerName, err := requiredEnvironment("AZURE_STORAGE_CONTAINER_NAME")
	if err != nil {
		return err
	}

	credential, err := service.NewSharedKeyCredential(accountName, accountKey)
	if err != nil {
		return fmt.Errorf("create shared key credential: %w", err)
	}
	client, err := service.NewClientWithSharedKeyCredential(accountURL, credential, nil)
	if err != nil {
		return fmt.Errorf("create Blob service client: %w", err)
	}

	deleteNames := make([]string, 500)
	for index := range deleteNames {
		deleteNames[index] = fmt.Sprintf("delete-target-%03d", index)
	}
	tierNames := make([]string, 200)
	for index := range tierNames {
		tierNames[index] = fmt.Sprintf("tier-target-%03d", index)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	deleteErr := deleteInBatches(ctx, client, containerName, deleteNames)
	tierErr := setTierInBatches(ctx, client, containerName, tierNames, blob.AccessTierCool)
	return errors.Join(deleteErr, tierErr)
}

func deleteInBatches(ctx context.Context, client *service.Client, containerName string, blobNames []string) error {
	return submitChunks(ctx, client, blobNames, func(builder *service.BatchBuilder, blobName string) error {
		return builder.Delete(containerName, blobName, nil)
	})
}

func setTierInBatches(ctx context.Context, client *service.Client, containerName string, blobNames []string, tier blob.AccessTier) error {
	return submitChunks(ctx, client, blobNames, func(builder *service.BatchBuilder, blobName string) error {
		return builder.SetTier(containerName, blobName, tier, nil)
	})
}

func submitChunks(
	ctx context.Context,
	client *service.Client,
	blobURLs []string,
	addOperation func(*service.BatchBuilder, string) error,
) error {
	var failures []operationFailure
	for start := 0; start < len(blobURLs); start += maxBatchOperations {
		end := min(start+maxBatchOperations, len(blobURLs))
		builder, err := client.NewBatchBuilder()
		if err != nil {
			return fmt.Errorf("create batch builder: %w", err)
		}
		for _, blobURL := range blobURLs[start:end] {
			if err := addOperation(builder, blobURL); err != nil {
				return fmt.Errorf("add operation to batch: %w", err)
			}
		}

		response, err := client.SubmitBatch(ctx, builder, nil)
		if err != nil {
			return describeAzureError("submit batch", err)
		}
		for index, subresponse := range response.Responses {
			if subresponse.Error != nil {
				blobName := "unknown"
				if subresponse.BlobName != nil {
					blobName = *subresponse.BlobName
				}
				failures = append(failures, operationFailure{
					Index:    start + index,
					BlobName: blobName,
					Err:      subresponse.Error,
				})
			}
		}
	}

	if len(failures) != 0 {
		for _, failure := range failures {
			log.Printf("batch operation %d for blob %q failed: %v", failure.Index, failure.BlobName, failure.Err)
		}
		return &batchError{Failures: failures}
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
