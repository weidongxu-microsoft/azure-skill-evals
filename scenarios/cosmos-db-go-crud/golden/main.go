package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos"
)

type item struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Name     string `json:"name"`
	Quantity int    `json:"quantity"`
}

func allowConflict(err error) error {
	if err == nil {
		return nil
	}
	var responseError *azcore.ResponseError
	if errors.As(err, &responseError) && responseError.StatusCode == 409 {
		return nil
	}
	return err
}

func run(ctx context.Context) error {
	connectionString := os.Getenv("AZURE_COSMOS_CONNECTION_STRING")
	if connectionString == "" {
		return errors.New("AZURE_COSMOS_CONNECTION_STRING is required")
	}
	client, err := azcosmos.NewClientFromConnectionString(connectionString, nil)
	if err != nil {
		return fmt.Errorf("create Cosmos client: %w", err)
	}
	_, err = client.CreateDatabase(ctx, azcosmos.DatabaseProperties{ID: "TestDB"}, nil)
	if err = allowConflict(err); err != nil {
		return fmt.Errorf("create database: %w", err)
	}
	database, err := client.NewDatabase("TestDB")
	if err != nil {
		return fmt.Errorf("create database client: %w", err)
	}
	_, err = database.CreateContainer(ctx, azcosmos.ContainerProperties{
		ID: "Items",
		PartitionKeyDefinition: azcosmos.PartitionKeyDefinition{
			Kind: azcosmos.PartitionKeyKindHash, Paths: []string{"/category"},
		},
	}, nil)
	if err = allowConflict(err); err != nil {
		return fmt.Errorf("create container: %w", err)
	}
	container, err := database.NewContainer("Items")
	if err != nil {
		return fmt.Errorf("create container client: %w", err)
	}
	partitionKey := azcosmos.NewPartitionKeyString("electronics")
	document := item{ID: "item-1", Category: "electronics", Name: "headphones", Quantity: 1}
	payload, err := json.Marshal(document)
	if err != nil {
		return err
	}
	if _, err = container.CreateItem(ctx, partitionKey, payload, nil); err != nil {
		return fmt.Errorf("create item: %w", err)
	}
	read, err := container.ReadItem(ctx, partitionKey, document.ID, nil)
	if err != nil {
		return fmt.Errorf("read item: %w", err)
	}
	fmt.Println(string(read.Value))
	pager := container.NewQueryItemsPager(
		"SELECT * FROM c WHERE c.category = @category",
		partitionKey,
		&azcosmos.QueryOptions{QueryParameters: []azcosmos.QueryParameter{{Name: "@category", Value: "electronics"}}},
	)
	for pager.More() {
		page, pageErr := pager.NextPage(ctx)
		if pageErr != nil {
			return fmt.Errorf("query items: %w", pageErr)
		}
		for _, result := range page.Items {
			fmt.Println(string(result))
		}
	}
	document.Quantity = 2
	payload, err = json.Marshal(document)
	if err != nil {
		return err
	}
	if _, err = container.ReplaceItem(ctx, partitionKey, document.ID, payload, nil); err != nil {
		return fmt.Errorf("replace item: %w", err)
	}
	if _, err = container.DeleteItem(ctx, partitionKey, document.ID, nil); err != nil {
		return fmt.Errorf("delete item: %w", err)
	}
	return nil
}

func main() {
	if err := run(context.Background()); err != nil {
		var responseError *azcore.ResponseError
		if errors.As(err, &responseError) {
			fmt.Fprintf(os.Stderr, "Cosmos request failed: status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
