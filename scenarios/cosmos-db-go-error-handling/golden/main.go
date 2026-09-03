package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos"
)

type inventoryItem struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Name     string `json:"name"`
}

func main() {
	if err := run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	connectionString, err := requiredEnvironment("AZURE_COSMOS_CONNECTION_STRING")
	if err != nil {
		return err
	}
	databaseName := environmentOr("AZURE_COSMOS_DATABASE", "TestDB")
	containerName := environmentOr("AZURE_COSMOS_CONTAINER", "Items")
	itemID := environmentOr("AZURE_COSMOS_ITEM_ID", "item-1")
	category := environmentOr("AZURE_COSMOS_PARTITION_KEY", "electronics")

	client, err := azcosmos.NewClientFromConnectionString(connectionString, &azcosmos.ClientOptions{
		ClientOptions: azcore.ClientOptions{Retry: policy.RetryOptions{
			MaxRetries:    3,
			RetryDelay:    500 * time.Millisecond,
			MaxRetryDelay: 10 * time.Second,
		}},
	})
	if err != nil {
		return fmt.Errorf("create Cosmos client: %w", err)
	}
	database, err := client.NewDatabase(databaseName)
	if err != nil {
		return fmt.Errorf("create database client: %w", err)
	}
	container, err := database.NewContainer(containerName)
	if err != nil {
		return fmt.Errorf("create container client: %w", err)
	}

	item := inventoryItem{ID: itemID, Category: category, Name: "headphones"}
	payload, err := json.Marshal(item)
	if err != nil {
		return fmt.Errorf("marshal item: %w", err)
	}
	partitionKey := azcosmos.NewPartitionKeyString(category)
	createResponse, err := container.CreateItem(ctx, partitionKey, payload, nil)
	if err != nil {
		if !reportExpectedError("create item", err, http.StatusConflict) {
			return fmt.Errorf("create item: %w", err)
		}
	} else {
		reportResponse("create item", createResponse.Response)
	}

	response, found, err := readItemWithRetry(ctx, container, partitionKey, itemID)
	if err != nil {
		return err
	}
	if found {
		reportResponse("read item", response.Response)
		fmt.Printf("item=%s\n", response.Value)
	}
	return nil
}

func readItemWithRetry(ctx context.Context, container *azcosmos.ContainerClient, partitionKey azcosmos.PartitionKey, itemID string) (azcosmos.ItemResponse, bool, error) {
	const maxAttempts = 3
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		response, err := container.ReadItem(ctx, partitionKey, itemID, nil)
		if err == nil {
			return response, true, nil
		}

		var responseError *azcore.ResponseError
		if !errors.As(err, &responseError) {
			return azcosmos.ItemResponse{}, false, fmt.Errorf("read item: %w", err)
		}
		reportResponseError("read item", responseError)
		switch responseError.StatusCode {
		case http.StatusNotFound:
			fmt.Fprintf(os.Stderr, "item %q was not found\n", itemID)
			return azcosmos.ItemResponse{}, false, nil
		case http.StatusConflict:
			fmt.Fprintf(os.Stderr, "item %q conflicts with an existing item\n", itemID)
			return azcosmos.ItemResponse{}, false, nil
		case http.StatusTooManyRequests:
			if attempt == maxAttempts {
				return azcosmos.ItemResponse{}, false, fmt.Errorf("read item remained throttled after %d attempts: %w", maxAttempts, err)
			}
			delay := retryDelay(responseError.RawResponse, attempt)
			fmt.Fprintf(os.Stderr, "throttled; retrying in %s (attempt %d/%d)\n", delay, attempt+1, maxAttempts)
			select {
			case <-time.After(delay):
			case <-ctx.Done():
				return azcosmos.ItemResponse{}, false, ctx.Err()
			}
		default:
			return azcosmos.ItemResponse{}, false, fmt.Errorf("read item: %w", err)
		}
	}
	return azcosmos.ItemResponse{}, false, errors.New("bounded retry loop ended unexpectedly")
}

func reportExpectedError(operation string, err error, status int) bool {
	var responseError *azcore.ResponseError
	if !errors.As(err, &responseError) || responseError.StatusCode != status {
		return false
	}
	reportResponseError(operation, responseError)
	return true
}

func reportResponse(operation string, response azcosmos.Response) {
	fmt.Printf("%s: request-charge=%.2f RU activity-id=%s diagnostics=%+v\n", operation, response.RequestCharge, response.ActivityID, response.Diagnostics)
}

func reportResponseError(operation string, responseError *azcore.ResponseError) {
	retryAfterMS, retryAfter, requestCharge, activityID := "", "", "", ""
	if responseError.RawResponse != nil {
		retryAfterMS = responseError.RawResponse.Header.Get("x-ms-retry-after-ms")
		retryAfter = responseError.RawResponse.Header.Get("Retry-After")
		requestCharge = responseError.RawResponse.Header.Get("x-ms-request-charge")
		activityID = responseError.RawResponse.Header.Get("x-ms-activity-id")
	}
	fmt.Fprintf(os.Stderr, "%s failed: status=%d code=%s retry-after-ms=%q retry-after=%q request-charge=%q activity-id=%q\n", operation, responseError.StatusCode, responseError.ErrorCode, retryAfterMS, retryAfter, requestCharge, activityID)
}

func retryDelay(response *http.Response, attempt int) time.Duration {
	if response != nil {
		if milliseconds, err := strconv.ParseInt(response.Header.Get("x-ms-retry-after-ms"), 10, 64); err == nil && milliseconds >= 0 {
			return min(time.Duration(milliseconds)*time.Millisecond, 30*time.Second)
		}
		if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds >= 0 {
			return min(time.Duration(seconds)*time.Second, 30*time.Second)
		}
		if retryAt, err := http.ParseTime(response.Header.Get("Retry-After")); err == nil {
			return min(max(time.Until(retryAt), 0), 30*time.Second)
		}
	}
	return min(time.Duration(1<<(attempt-1))*500*time.Millisecond, 5*time.Second)
}

func requiredEnvironment(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func environmentOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
