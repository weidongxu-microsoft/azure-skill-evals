package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
)

func main() {
	if err := run(context.Background()); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	tenantID, err := requiredEnvironment("AZURE_TENANT_ID")
	if err != nil {
		return err
	}
	clientID, err := requiredEnvironment("AZURE_CLIENT_ID")
	if err != nil {
		return err
	}
	// Keep client secrets in a secret store or injected environment variable.
	// Never commit or log this value.
	clientSecret, err := requiredEnvironment("AZURE_CLIENT_SECRET")
	if err != nil {
		return err
	}
	vaultURL, err := requiredEnvironment("AZURE_KEY_VAULT_URL")
	if err != nil {
		return err
	}
	secretName, err := requiredEnvironment("AZURE_SECRET_NAME")
	if err != nil {
		return err
	}

	credential, err := azidentity.NewClientSecretCredential(
		tenantID,
		clientID,
		clientSecret,
		nil,
	)
	if err != nil {
		return fmt.Errorf("create client secret credential: %w", err)
	}
	client, err := azsecrets.NewClient(vaultURL, credential, nil)
	if err != nil {
		return fmt.Errorf("create Key Vault client: %w", err)
	}

	secret, err := client.GetSecret(ctx, secretName, "", nil)
	if err != nil {
		return describeAzureError("authenticate and get secret", err)
	}
	fmt.Printf("Read secret %q (value present: %t)\n", secretName, secret.Value != nil)
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
