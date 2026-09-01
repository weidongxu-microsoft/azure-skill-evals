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

// DefaultAzureCredential tries EnvironmentCredential,
// WorkloadIdentityCredential, ManagedIdentityCredential, AzureCLICredential,
// AzureDeveloperCLICredential, and AzurePowerShellCredential, in that order.
// Local development normally uses a signed-in CLI credential. Azure-hosted
// applications normally use workload identity or managed identity.
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

	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create default Azure credential: %w", err)
	}
	client, err := azsecrets.NewClient(vaultURL, credential, nil)
	if err != nil {
		return fmt.Errorf("create Key Vault client: %w", err)
	}

	secret, err := client.GetSecret(ctx, secretName, "", nil)
	if err != nil {
		// For troubleshooting, inspect the credential error, verify Azure CLI
		// sign-in locally, and verify identity assignment and RBAC in Azure.
		return describeAzureError("get secret", err)
	}
	fmt.Printf("Secret %q has a value: %t\n", secretName, secret.Value != nil)
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
