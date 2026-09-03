package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/log"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/blockblob"
	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/lease"
)

type BlobManager struct {
	client     *azblob.Client
	credential azcore.TokenCredential
	endpoint   string
	container  string
}

func operationContext(parent context.Context, timeout time.Duration) (context.Context, context.CancelFunc) {
	if timeout <= 0 {
		return context.WithCancel(parent)
	}
	return context.WithTimeout(parent, timeout)
}

func (manager *BlobManager) blobURL(name string) string {
	return strings.TrimRight(manager.endpoint, "/") + "/" + manager.container + "/" + name
}

func (manager *BlobManager) UploadFile(ctx context.Context, name, path string, metadata map[string]*string, tags map[string]string, timeout time.Duration) error {
	ctx, cancel := operationContext(ctx, timeout)
	defer cancel()
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open upload file: %w", err)
	}
	defer file.Close()
	client, err := blockblob.NewClient(manager.blobURL(name), manager.credential, nil)
	if err != nil {
		return fmt.Errorf("create block blob client: %w", err)
	}
	_, err = client.UploadFile(ctx, file, &blockblob.UploadFileOptions{Metadata: metadata, Tags: tags, Concurrency: 4})
	return describeStorageError("upload", err)
}

func (manager *BlobManager) List(ctx context.Context, timeout time.Duration, visit func(string)) error {
	ctx, cancel := operationContext(ctx, timeout)
	defer cancel()
	pager := manager.client.NewListBlobsFlatPager(manager.container, nil)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return describeStorageError("list", err)
		}
		for _, item := range page.Segment.BlobItems {
			if item.Name != nil {
				visit(*item.Name)
			}
		}
	}
	return nil
}

func (manager *BlobManager) DownloadFile(ctx context.Context, name, path string, timeout time.Duration) error {
	ctx, cancel := operationContext(ctx, timeout)
	defer cancel()
	client, err := blob.NewClient(manager.blobURL(name), manager.credential, nil)
	if err != nil {
		return fmt.Errorf("create blob client: %w", err)
	}
	response, err := client.DownloadStream(ctx, nil)
	if err != nil {
		return describeStorageError("download", err)
	}
	defer response.Body.Close()
	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create download file: %w", err)
	}
	if _, err := io.Copy(file, response.Body); err != nil {
		file.Close()
		return fmt.Errorf("stream download: %w", err)
	}
	return file.Close()
}

func (manager *BlobManager) OverwriteWithLease(ctx context.Context, name, path string, timeout time.Duration) error {
	ctx, cancel := operationContext(ctx, timeout)
	defer cancel()
	blobClient, err := blob.NewClient(manager.blobURL(name), manager.credential, nil)
	if err != nil {
		return fmt.Errorf("create blob client: %w", err)
	}
	leaseClient, err := lease.NewBlobClient(blobClient, nil)
	if err != nil {
		return fmt.Errorf("create lease client: %w", err)
	}
	acquired, err := leaseClient.AcquireLease(ctx, -1, nil)
	if err != nil {
		return describeStorageError("acquire lease", err)
	}
	if acquired.LeaseID == nil {
		return errors.New("lease response did not include a lease ID")
	}
	leaseID := *acquired.LeaseID
	leaseClient, err = lease.NewBlobClient(blobClient, &lease.BlobClientOptions{LeaseID: &leaseID})
	if err != nil {
		return fmt.Errorf("create acquired lease client: %w", err)
	}
	defer func() {
		if _, releaseErr := leaseClient.ReleaseLease(context.WithoutCancel(ctx), nil); releaseErr != nil {
			fmt.Fprintf(os.Stderr, "release lease failed: %v\n", releaseErr)
		}
	}()
	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open overwrite file: %w", err)
	}
	defer file.Close()
	blockClient, err := blockblob.NewClient(manager.blobURL(name), manager.credential, nil)
	if err != nil {
		return fmt.Errorf("create block blob client: %w", err)
	}
	conditions := &blob.AccessConditions{LeaseAccessConditions: &blob.LeaseAccessConditions{LeaseID: &leaseID}}
	_, err = blockClient.UploadFile(ctx, file, &blockblob.UploadFileOptions{AccessConditions: conditions, Concurrency: 4})
	return describeStorageError("leased overwrite", err)
}

func (manager *BlobManager) Delete(ctx context.Context, name string, timeout time.Duration) error {
	ctx, cancel := operationContext(ctx, timeout)
	defer cancel()
	_, err := manager.client.DeleteBlob(ctx, manager.container, name, nil)
	return describeStorageError("delete", err)
}

func describeStorageError(operation string, err error) error {
	if err == nil {
		return nil
	}
	var responseError *azcore.ResponseError
	if errors.As(err, &responseError) {
		switch responseError.StatusCode {
		case 404:
			return fmt.Errorf("%s: blob not found (code=%s): %w", operation, responseError.ErrorCode, err)
		case 409:
			return fmt.Errorf("%s: lease conflict (code=%s): %w", operation, responseError.ErrorCode, err)
		default:
			return fmt.Errorf("%s: storage status=%d code=%s: %w", operation, responseError.StatusCode, responseError.ErrorCode, err)
		}
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func newBlobManager() (*BlobManager, error) {
	endpoint, container := os.Getenv("AZURE_STORAGE_BLOB_ENDPOINT"), os.Getenv("AZURE_STORAGE_CONTAINER")
	if endpoint == "" || container == "" {
		return nil, errors.New("AZURE_STORAGE_BLOB_ENDPOINT and AZURE_STORAGE_CONTAINER are required")
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, fmt.Errorf("create credential: %w", err)
	}
	maxRetries := int32(5)
	if value := os.Getenv("AZURE_STORAGE_MAX_RETRIES"); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 32)
		if err != nil || parsed < 0 {
			return nil, fmt.Errorf("AZURE_STORAGE_MAX_RETRIES must be a non-negative integer")
		}
		maxRetries = int32(parsed)
	}
	options := &azblob.ClientOptions{ClientOptions: azcore.ClientOptions{Retry: policy.RetryOptions{
		MaxRetries: maxRetries, RetryDelay: time.Second, MaxRetryDelay: 16 * time.Second,
	}}}
	client, err := azblob.NewClient(endpoint, credential, options)
	if err != nil {
		return nil, fmt.Errorf("create Blob client: %w", err)
	}
	return &BlobManager{client: client, credential: credential, endpoint: endpoint, container: container}, nil
}

func run(ctx context.Context) error {
	log.SetEvents(log.EventRequest, log.EventResponse, log.EventRetryPolicy)
	log.SetListener(func(event log.Event, message string) {
		fmt.Fprintf(os.Stderr, "azure-sdk %s: %s\n", event, message)
	})
	manager, err := newBlobManager()
	if err != nil {
		return err
	}
	sample, err := os.CreateTemp("", "blob-manager-upload-*.txt")
	if err != nil {
		return err
	}
	samplePath := sample.Name()
	defer os.Remove(samplePath)
	if _, err := sample.WriteString("initial content\n"); err != nil {
		sample.Close()
		return err
	}
	if err := sample.Close(); err != nil {
		return err
	}
	metadataValue := "blob-manager-demo"
	if err := manager.UploadFile(ctx, "demo.txt", samplePath, map[string]*string{"source": &metadataValue}, map[string]string{"category": "sample"}, 2*time.Minute); err != nil {
		return err
	}
	fmt.Println("uploaded demo.txt")
	if err := manager.List(ctx, time.Minute, func(name string) { fmt.Println("blob:", name) }); err != nil {
		return err
	}
	downloadPath := samplePath + ".downloaded"
	defer os.Remove(downloadPath)
	if err := manager.DownloadFile(ctx, "demo.txt", downloadPath, 2*time.Minute); err != nil {
		return err
	}
	fmt.Println("downloaded demo.txt")
	if err := os.WriteFile(samplePath, []byte("leased overwrite\n"), 0o600); err != nil {
		return err
	}
	if err := manager.OverwriteWithLease(ctx, "demo.txt", samplePath, 2*time.Minute); err != nil {
		return err
	}
	fmt.Println("overwrote demo.txt under lease")
	if err := manager.Delete(ctx, "demo.txt", time.Minute); err != nil {
		return err
	}
	fmt.Println("deleted demo.txt")
	return nil
}

func main() {
	if err := run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
