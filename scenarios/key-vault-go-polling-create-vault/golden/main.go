package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/resourcemanager/keyvault/armkeyvault"
	"github.com/Azure/azure-sdk-for-go/sdk/security/keyvault/azsecrets"
)

func required(name string) (string, error) {
	value := os.Getenv(name)
	if value == "" {
		return "", fmt.Errorf("%s is required", name)
	}
	return value, nil
}

func run(ctx context.Context) error {
	subscriptionID, err := required("AZURE_SUBSCRIPTION_ID")
	if err != nil {
		return err
	}
	tenantID, err := required("AZURE_TENANT_ID")
	if err != nil {
		return err
	}
	resourceGroup, err := required("AZURE_RESOURCE_GROUP")
	if err != nil {
		return err
	}
	vaultName, err := required("AZURE_KEY_VAULT_NAME")
	if err != nil {
		return err
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create credential: %w", err)
	}
	client, err := armkeyvault.NewVaultsClient(subscriptionID, credential, nil)
	if err != nil {
		return fmt.Errorf("create vaults client: %w", err)
	}
	enabled := true
	standard := armkeyvault.SKUNameStandard
	family := armkeyvault.SKUFamilyA
	poller, err := client.BeginCreateOrUpdate(ctx, resourceGroup, vaultName, armkeyvault.VaultCreateOrUpdateParameters{
		Location: pointer("eastus"),
		Properties: &armkeyvault.VaultProperties{
			TenantID:                &tenantID,
			SKU:                     &armkeyvault.SKU{Name: &standard, Family: &family},
			AccessPolicies:          []*armkeyvault.AccessPolicyEntry{},
			EnableRbacAuthorization: &enabled,
			EnableSoftDelete:        &enabled,
			EnablePurgeProtection:   &enabled,
		},
	}, nil)
	if err != nil {
		return fmt.Errorf("begin vault creation: %w", err)
	}
	result, err := poller.PollUntilDone(ctx, nil)
	if err != nil {
		return fmt.Errorf("poll vault creation: %w", err)
	}
	if result.Properties == nil || result.Properties.VaultURI == nil {
		return errors.New("created vault response did not include VaultURI")
	}
	secretClient, err := azsecrets.NewClient(*result.Properties.VaultURI, credential, nil)
	if err != nil {
		return fmt.Errorf("create secrets client: %w", err)
	}
	_ = secretClient
	fmt.Println("vault data-plane client ready:", *result.Properties.VaultURI)
	fmt.Println("RBAC data roles must be assigned separately to the caller or managed identity; legacy access policies are disabled")
	return nil
}

func pointer[T any](value T) *T { return &value }

func main() {
	if err := run(context.Background()); err != nil {
		var responseError *azcore.ResponseError
		if errors.As(err, &responseError) {
			if responseError.StatusCode == 409 {
				fmt.Fprintf(os.Stderr, "vault name conflicts with an existing or soft-deleted vault: code=%s\n", responseError.ErrorCode)
			} else {
				fmt.Fprintf(os.Stderr, "Azure request failed: status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
			}
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
