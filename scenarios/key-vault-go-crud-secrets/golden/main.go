package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
)

const secretName = "my-secret"

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	vaultURL, err := requiredEnvironment("AZURE_KEY_VAULT_URL")
	if err != nil {
		return err
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create default Azure credential: %w", err)
	}
	client, err := azsecrets.NewClient(vaultURL, credential, nil)
	if err != nil {
		return fmt.Errorf("create secrets client: %w", err)
	}

	if _, err := client.SetSecret(
		ctx,
		secretName,
		azsecrets.SetSecretParameters{Value: pointer("my-secret-value")},
		nil,
	); err != nil {
		return describeAzureError("create secret", err)
	}

	secret, err := client.GetSecret(ctx, secretName, "", nil)
	if err != nil {
		return describeAzureError("read secret", err)
	}
	fmt.Printf("Secret value: %s\n", value(secret.Value))

	if _, err := client.SetSecret(
		ctx,
		secretName,
		azsecrets.SetSecretParameters{Value: pointer("updated-value")},
		nil,
	); err != nil {
		return describeAzureError("update secret", err)
	}

	if _, err := client.DeleteSecret(ctx, secretName, nil); err != nil {
		return describeAzureError("delete secret", err)
	}
	if err := waitForDeletedSecret(ctx, client, secretName); err != nil {
		return err
	}
	if _, err := client.PurgeDeletedSecret(ctx, secretName, nil); err != nil {
		return describeAzureError("purge deleted secret", err)
	}
	return nil
}

func waitForDeletedSecret(
	ctx context.Context,
	client *azsecrets.Client,
	name string,
) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for attempt := 0; attempt < 30; attempt++ {
		if _, err := client.GetDeletedSecret(ctx, name, nil); err == nil {
			return nil
		} else {
			var responseError *azcore.ResponseError
			if !errors.As(err, &responseError) ||
				responseError.StatusCode != http.StatusNotFound {
				return describeAzureError("wait for deleted secret", err)
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("wait for deleted secret: %w", ctx.Err())
		case <-ticker.C:
		}
	}
	return fmt.Errorf("deleted secret %q did not become available to purge", name)
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

func pointer[T any](value T) *T {
	return &value
}

func value[T any](pointer *T) T {
	if pointer == nil {
		var zero T
		return zero
	}
	return *pointer
}
