package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos"
)

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
	client, err := azcosmos.NewClientFromConnectionString(connectionString, nil)
	if err != nil {
		return fmt.Errorf("create Cosmos client: %w", err)
	}
	database, err := client.NewDatabase(environmentOr("AZURE_COSMOS_DATABASE", "TestDB"))
	if err != nil {
		return fmt.Errorf("create database client: %w", err)
	}
	container, err := database.NewContainer(environmentOr("AZURE_COSMOS_CONTAINER", "Items"))
	if err != nil {
		return fmt.Errorf("create container client: %w", err)
	}

	resumeToken := os.Getenv("AZURE_COSMOS_CONTINUATION_TOKEN")
	var continuationToken *string
	if resumeToken != "" {
		continuationToken = &resumeToken
	}
	crossPartition := true
	options := &azcosmos.QueryOptions{
		PageSizeHint:              50,
		ContinuationToken:         continuationToken,
		EnableCrossPartitionQuery: &crossPartition,
		QueryParameters: []azcosmos.QueryParameter{
			{Name: "@category", Value: "electronics"},
		},
	}
	fmt.Println("Using an empty partition key with cross-partition querying so Cosmos DB fans the query across logical partitions.")
	fmt.Println("NewQueryItemsPager retains continuation state; More and NextPage process each service page in order.")
	pager := container.NewQueryItemsPager(
		"SELECT * FROM c WHERE c.category = @category",
		azcosmos.NewPartitionKey(),
		options,
	)

	var totalRequestCharge float32
	pageNumber := 0
	for pager.More() {
		page, pageErr := pager.NextPage(ctx)
		if pageErr != nil {
			return describeResponseError("query page", pageErr)
		}
		pageNumber++
		for _, item := range page.Items {
			fmt.Println(string(item))
		}
		token := ""
		if page.ContinuationToken != nil {
			token = *page.ContinuationToken
		}
		fmt.Printf("page=%d continuation-token=%q request-charge=%.2f RU\n", pageNumber, token, page.RequestCharge)
		totalRequestCharge += page.RequestCharge
	}
	fmt.Printf("total-request-charge=%.2f RU\n", totalRequestCharge)
	return nil
}

func describeResponseError(operation string, err error) error {
	var responseError *azcore.ResponseError
	if errors.As(err, &responseError) {
		return fmt.Errorf("%s failed: status=%d code=%s: %w", operation, responseError.StatusCode, responseError.ErrorCode, err)
	}
	return fmt.Errorf("%s failed: %w", operation, err)
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
