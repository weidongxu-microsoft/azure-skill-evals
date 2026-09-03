package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/log"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
)

func reportResponseError(operation string, err error) {
	if err == nil {
		fmt.Printf("%s unexpectedly succeeded\n", operation)
		return
	}
	var responseError *azcore.ResponseError
	if !errors.As(err, &responseError) {
		fmt.Printf("%s failed before an HTTP response: %v\n", operation, err)
		return
	}
	statusCode, errorCode := responseError.StatusCode, responseError.ErrorCode
	switch statusCode {
	case 404:
		fmt.Printf("%s: not found (status=%d code=%s)\n", operation, statusCode, errorCode)
	case 403:
		fmt.Printf("%s: access denied; verify Blob Data RBAC (status=%d code=%s)\n", operation, statusCode, errorCode)
	case 409:
		fmt.Printf("%s: conflict, commonly an active or missing lease (status=%d code=%s)\n", operation, statusCode, errorCode)
	case 429:
		fmt.Printf("%s: throttled after SDK retries (status=%d code=%s)\n", operation, statusCode, errorCode)
	default:
		fmt.Printf("%s: Azure request failed (status=%d code=%s)\n", operation, statusCode, errorCode)
	}
}

func run(ctx context.Context) error {
	endpoint, containerName, blobName := os.Getenv("AZURE_STORAGE_BLOB_ENDPOINT"), os.Getenv("AZURE_STORAGE_CONTAINER"), os.Getenv("AZURE_STORAGE_BLOB_NAME")
	if endpoint == "" || containerName == "" || blobName == "" {
		return errors.New("AZURE_STORAGE_BLOB_ENDPOINT, AZURE_STORAGE_CONTAINER, and AZURE_STORAGE_BLOB_NAME are required")
	}
	log.SetEvents(log.EventRequest, log.EventResponse, log.EventRetryPolicy)
	log.SetListener(func(event log.Event, message string) {
		fmt.Fprintf(os.Stderr, "azure-sdk %s: %s\n", event, message)
	})
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create credential: %w", err)
	}
	options := &azblob.ClientOptions{ClientOptions: azcore.ClientOptions{Retry: policy.RetryOptions{
		MaxRetries: 5, RetryDelay: time.Second, MaxRetryDelay: 16 * time.Second,
	}}}
	client, err := azblob.NewClient(endpoint, credential, options)
	if err != nil {
		return fmt.Errorf("create Blob client: %w", err)
	}

	missingPager := client.NewListBlobsFlatPager(containerName+"-missing", nil)
	if missingPager.More() {
		_, err := missingPager.NextPage(ctx)
		reportResponseError("missing container", err)
	}

	blobURL := strings.TrimRight(endpoint, "/") + "/" + containerName + "/" + blobName
	blobClient, err := blob.NewClient(blobURL, credential, &blob.ClientOptions{ClientOptions: options.ClientOptions})
	if err != nil {
		return fmt.Errorf("create blob client: %w", err)
	}
	wrongETag := azcore.ETag("\"not-the-current-etag\"")
	etagConditions := &blob.AccessConditions{ModifiedAccessConditions: &blob.ModifiedAccessConditions{IfMatch: &wrongETag}}
	response, err := blobClient.DownloadStream(ctx, &blob.DownloadStreamOptions{AccessConditions: etagConditions})
	if err == nil {
		response.Body.Close()
	}
	reportResponseError("ETag conditional download", err)

	invalidLeaseID := "00000000-0000-0000-0000-000000000000"
	leaseConditions := &blob.AccessConditions{LeaseAccessConditions: &blob.LeaseAccessConditions{LeaseID: &invalidLeaseID}}
	_, err = blobClient.Delete(ctx, &blob.DeleteOptions{AccessConditions: leaseConditions})
	reportResponseError("lease conditional delete", err)
	return nil
}

func main() {
	if err := run(context.Background()); err != nil {
		var responseError *azcore.ResponseError
		if errors.As(err, &responseError) {
			reportResponseError("Blob operation", responseError)
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
