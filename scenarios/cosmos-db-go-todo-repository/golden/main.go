package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos"
)

type todoItem struct {
	ID          string      `json:"id"`
	Title       string      `json:"title"`
	Description string      `json:"description"`
	Completed   bool        `json:"completed"`
	CreatedAt   time.Time   `json:"createdAt"`
	Category    string      `json:"category"`
	ETag        azcore.ETag `json:"-"`
}

type repository struct{ container *azcosmos.ContainerClient }

func (repo *repository) create(ctx context.Context, item *todoItem) error {
	payload, err := json.Marshal(item)
	if err != nil {
		return err
	}
	response, err := repo.container.CreateItem(ctx, azcosmos.NewPartitionKeyString(item.Category), payload, nil)
	if err != nil {
		return fmt.Errorf("create todo: %w", err)
	}
	item.ETag = response.ETag
	fmt.Printf("create RU=%.2f\n", response.RequestCharge)
	return nil
}

func (repo *repository) read(ctx context.Context, id, category string) (todoItem, error) {
	response, err := repo.container.ReadItem(ctx, azcosmos.NewPartitionKeyString(category), id, nil)
	if err != nil {
		return todoItem{}, fmt.Errorf("read todo: %w", err)
	}
	var item todoItem
	if err := json.Unmarshal(response.Value, &item); err != nil {
		return todoItem{}, err
	}
	item.ETag = response.ETag
	fmt.Printf("read RU=%.2f\n", response.RequestCharge)
	return item, nil
}

func (repo *repository) update(ctx context.Context, item *todoItem) error {
	payload, err := json.Marshal(item)
	if err != nil {
		return err
	}
	response, err := repo.container.ReplaceItem(ctx, azcosmos.NewPartitionKeyString(item.Category), item.ID, payload, &azcosmos.ItemOptions{IfMatchEtag: &item.ETag})
	if err != nil {
		var responseError *azcore.ResponseError
		if errors.As(err, &responseError) && responseError.StatusCode == 412 {
			return fmt.Errorf("todo %s was modified concurrently: %w", item.ID, err)
		}
		return fmt.Errorf("update todo: %w", err)
	}
	item.ETag = response.ETag
	fmt.Printf("update RU=%.2f\n", response.RequestCharge)
	return nil
}

func (repo *repository) delete(ctx context.Context, id, category string) error {
	response, err := repo.container.DeleteItem(ctx, azcosmos.NewPartitionKeyString(category), id, nil)
	if err != nil {
		return fmt.Errorf("delete todo: %w", err)
	}
	fmt.Printf("delete RU=%.2f\n", response.RequestCharge)
	return nil
}

func (repo *repository) queryByCategory(ctx context.Context, category string) error {
	pager := repo.container.NewQueryItemsPager(
		"SELECT * FROM c WHERE c.category = @category",
		azcosmos.NewPartitionKeyString(category),
		&azcosmos.QueryOptions{PageSizeHint: 25, QueryParameters: []azcosmos.QueryParameter{{Name: "@category", Value: category}}},
	)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("query todos: %w", err)
		}
		continuation := ""
		if page.ContinuationToken != nil {
			continuation = *page.ContinuationToken
		}
		fmt.Printf("query page items=%d continuation=%q RU=%.2f\n", len(page.Items), continuation, page.RequestCharge)
	}
	return nil
}

func allowConflict(err error) error {
	var responseError *azcore.ResponseError
	if errors.As(err, &responseError) && responseError.StatusCode == 409 {
		return nil
	}
	return err
}

func buildRepository(ctx context.Context) (*repository, error) {
	endpoint := os.Getenv("AZURE_COSMOS_ENDPOINT")
	if endpoint == "" {
		return nil, errors.New("AZURE_COSMOS_ENDPOINT is required")
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return nil, err
	}
	client, err := azcosmos.NewClient(endpoint, credential, nil)
	if err != nil {
		return nil, err
	}
	_, err = client.CreateDatabase(ctx, azcosmos.DatabaseProperties{ID: "TodoDB"}, nil)
	if err = allowConflict(err); err != nil {
		return nil, fmt.Errorf("create database: %w", err)
	}
	database, err := client.NewDatabase("TodoDB")
	if err != nil {
		return nil, err
	}
	ttl := int32(90 * 24 * 60 * 60)
	_, err = database.CreateContainer(ctx, azcosmos.ContainerProperties{
		ID:                     "Todos",
		PartitionKeyDefinition: azcosmos.PartitionKeyDefinition{Kind: azcosmos.PartitionKeyKindHash, Paths: []string{"/category"}},
		DefaultTimeToLive:      &ttl,
		IndexingPolicy:         &azcosmos.IndexingPolicy{Automatic: true, IndexingMode: azcosmos.IndexingModeConsistent, IncludedPaths: []azcosmos.IncludedPath{{Path: "/*"}}, ExcludedPaths: []azcosmos.ExcludedPath{{Path: "/description/?"}}},
	}, nil)
	if err = allowConflict(err); err != nil {
		return nil, fmt.Errorf("create container: %w", err)
	}
	container, err := database.NewContainer("Todos")
	if err != nil {
		return nil, err
	}
	return &repository{container: container}, nil
}

func run(ctx context.Context) error {
	repo, err := buildRepository(ctx)
	if err != nil {
		return err
	}
	item := todoItem{ID: "todo-1", Title: "Ship", Description: "Ship release", CreatedAt: time.Now().UTC(), Category: "work"}
	if err := repo.create(ctx, &item); err != nil {
		return err
	}
	item, err = repo.read(ctx, item.ID, item.Category)
	if err != nil {
		return err
	}
	item.Completed = true
	if err := repo.update(ctx, &item); err != nil {
		return err
	}
	if err := repo.queryByCategory(ctx, item.Category); err != nil {
		return err
	}
	return repo.delete(ctx, item.ID, item.Category)
}

func main() {
	if err := run(context.Background()); err != nil {
		var responseError *azcore.ResponseError
		if errors.As(err, &responseError) {
			switch responseError.StatusCode {
			case http.StatusNotFound:
				fmt.Fprintf(os.Stderr, "Cosmos resource was not found: code=%s\n", responseError.ErrorCode)
			case http.StatusConflict:
				fmt.Fprintf(os.Stderr, "Cosmos resource already exists: code=%s\n", responseError.ErrorCode)
			case http.StatusPreconditionFailed:
				fmt.Fprintf(os.Stderr, "Cosmos item changed since it was read: code=%s\n", responseError.ErrorCode)
			default:
				fmt.Fprintf(os.Stderr, "Cosmos request failed: status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
			}
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
