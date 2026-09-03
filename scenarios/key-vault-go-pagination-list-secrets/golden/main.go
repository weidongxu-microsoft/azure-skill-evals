package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
)

func main() {
	if err := run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	vaultURL := os.Getenv("AZURE_KEY_VAULT_URL")
	if vaultURL == "" {
		return errors.New("AZURE_KEY_VAULT_URL is required")
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create credential: %w", err)
	}
	client, err := azsecrets.NewClient(vaultURL, credential, nil)
	if err != nil {
		return fmt.Errorf("create secrets client: %w", err)
	}

	pager := client.NewListSecretPropertiesPager(nil)
	pageNumber := 0
	for pager.More() {
		page, pageErr := pager.NextPage(ctx)
		if pageErr != nil {
			return describePageError(pageNumber+1, pageErr)
		}
		pageNumber++
		fmt.Printf("page=%d secrets=%d\n", pageNumber, len(page.Value))
		for _, secret := range page.Value {
			printSecret(secret)
		}
	}
	return nil
}

func printSecret(secret *azsecrets.SecretProperties) {
	if secret == nil {
		return
	}
	name, contentType, enabled, created := "", "", "unknown", "unknown"
	if secret.ID != nil {
		name = secret.ID.Name()
	}
	if secret.ContentType != nil {
		contentType = *secret.ContentType
	}
	state := "enabled state unavailable"
	if secret.Attributes != nil {
		if secret.Attributes.Enabled != nil {
			enabled = fmt.Sprintf("%t", *secret.Attributes.Enabled)
			if *secret.Attributes.Enabled {
				state = "enabled"
			} else {
				state = "disabled; do not use until explicitly enabled"
			}
		}
		if secret.Attributes.Created != nil {
			created = secret.Attributes.Created.UTC().Format("2006-01-02T15:04:05Z07:00")
		}
	}
	fmt.Printf("name=%q content-type=%q enabled=%s created=%s state=%q\n", name, contentType, enabled, created, state)
}

func describePageError(pageNumber int, err error) error {
	var responseError *azcore.ResponseError
	if errors.As(err, &responseError) {
		return fmt.Errorf("list secret properties page %d failed: status=%d code=%s: %w", pageNumber, responseError.StatusCode, responseError.ErrorCode, err)
	}
	return fmt.Errorf("list secret properties page %d failed: %w", pageNumber, err)
}
