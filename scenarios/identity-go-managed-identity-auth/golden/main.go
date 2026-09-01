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
	vaultURL, err := requiredEnvironment("AZURE_KEY_VAULT_URL")
	if err != nil {
		return err
	}
	secretName, err := requiredEnvironment("AZURE_SECRET_NAME")
	if err != nil {
		return err
	}
	userAssignedClientID, err := requiredEnvironment(
		"AZURE_MANAGED_IDENTITY_CLIENT_ID",
	)
	if err != nil {
		return err
	}

	// Nil options select the Azure resource's system-assigned identity.
	systemCredential, err := azidentity.NewManagedIdentityCredential(nil)
	if err != nil {
		return fmt.Errorf("create system-assigned credential: %w", err)
	}
	// Supplying a ClientID selects a user-assigned managed identity.
	userCredential, err := azidentity.NewManagedIdentityCredential(
		&azidentity.ManagedIdentityCredentialOptions{
			ID: azidentity.ClientID(userAssignedClientID),
		},
	)
	if err != nil {
		return fmt.Errorf("create user-assigned credential: %w", err)
	}

	// DefaultAzureCredential includes ManagedIdentityCredential for Azure
	// hosting and developer credentials for local development.
	defaultCredential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create local fallback credential: %w", err)
	}
	fallbackCredential, err := azidentity.NewChainedTokenCredential(
		[]azcore.TokenCredential{systemCredential, defaultCredential},
		nil,
	)
	if err != nil {
		return fmt.Errorf("create managed identity fallback chain: %w", err)
	}

	systemClient, err := azsecrets.NewClient(vaultURL, systemCredential, nil)
	if err != nil {
		return fmt.Errorf("create system-assigned Key Vault client: %w", err)
	}
	userClient, err := azsecrets.NewClient(vaultURL, userCredential, nil)
	if err != nil {
		return fmt.Errorf("create user-assigned Key Vault client: %w", err)
	}
	fallbackClient, err := azsecrets.NewClient(vaultURL, fallbackCredential, nil)
	if err != nil {
		return fmt.Errorf("create fallback Key Vault client: %w", err)
	}

	client := fallbackClient
	switch os.Getenv("AZURE_MANAGED_IDENTITY_TYPE") {
	case "system":
		client = systemClient
	case "user":
		client = userClient
	}

	if _, err := client.GetSecret(ctx, secretName, "", nil); err != nil {
		// Locally, managed identity endpoints are unavailable. Use the
		// fallback chain after signing in with an Azure developer tool.
		return describeAzureError("authenticate and get secret", err)
	}
	fmt.Printf("Authenticated and read secret %q\n", secretName)
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
