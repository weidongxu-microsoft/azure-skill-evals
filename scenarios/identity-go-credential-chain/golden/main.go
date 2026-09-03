package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
)

const armScope = "https://management.azure.com/.default"

type environment string

type unavailableCredential struct {
	name  string
	cause error
}

func (credential unavailableCredential) GetToken(context.Context, policy.TokenRequestOptions) (azcore.AccessToken, error) {
	return azcore.AccessToken{}, azidentity.NewCredentialUnavailableError(fmt.Sprintf("%s is not configured: %v", credential.name, credential.cause))
}

const (
	environmentDev        environment = "development"
	environmentCI         environment = "ci"
	environmentProduction environment = "production"
)

func main() {
	if err := run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	current := detectEnvironment()
	credential, strategy, err := buildCredential(current)
	if err != nil {
		return err
	}
	fmt.Printf("detected-environment=%s\nselected-strategy=%s\n", current, strategy)

	token, err := credential.GetToken(ctx, policy.TokenRequestOptions{
		Scopes:    []string{armScope},
		EnableCAE: true,
	})
	if err != nil {
		return describeAuthenticationError(err)
	}
	fmt.Printf("authentication=success cae-requested=true expires-at=%s\n", token.ExpiresOn.UTC().Format("2006-01-02T15:04:05Z07:00"))
	return nil
}

func detectEnvironment() environment {
	if anyEnvironment("CI", "TF_BUILD", "BUILD_SOURCESDIRECTORY", "AZURE_PIPELINE_WORKSPACE", "GITHUB_ACTIONS") {
		return environmentCI
	}
	if anyEnvironment("IDENTITY_ENDPOINT", "MSI_ENDPOINT", "IMDS_ENDPOINT", "AZURE_FEDERATED_TOKEN_FILE", "KUBERNETES_SERVICE_HOST") {
		return environmentProduction
	}
	return environmentDev
}

func buildCredential(current environment) (*azidentity.ChainedTokenCredential, string, error) {
	var sources []azcore.TokenCredential
	var strategy string
	switch current {
	case environmentDev:
		cli, err := azidentity.NewAzureCLICredential(nil)
		if err != nil {
			return nil, "", fmt.Errorf("create Azure CLI credential: %w", err)
		}
		developerCLI, err := azidentity.NewAzureDeveloperCLICredential(nil)
		if err != nil {
			return nil, "", fmt.Errorf("create Azure Developer CLI credential: %w", err)
		}
		sources = []azcore.TokenCredential{cli, developerCLI}
		strategy = "Azure CLI, then Azure Developer CLI"
	case environmentCI:
		environmentCredential, environmentErr := azidentity.NewEnvironmentCredential(nil)
		workload, workloadErr := azidentity.NewWorkloadIdentityCredential(nil)
		sources = []azcore.TokenCredential{environmentCredential, workload}
		sources[0] = configuredCredential("environment credential", sources[0], environmentErr)
		sources[1] = configuredCredential("workload identity", sources[1], workloadErr)
		strategy = "environment credential, then workload identity"
	case environmentProduction:
		managedOptions := &azidentity.ManagedIdentityCredentialOptions{}
		if clientID := os.Getenv("AZURE_MANAGED_IDENTITY_CLIENT_ID"); clientID != "" {
			managedOptions.ID = azidentity.ClientID(clientID)
		}
		managed, err := azidentity.NewManagedIdentityCredential(managedOptions)
		if err != nil {
			return nil, "", fmt.Errorf("create managed identity credential: %w", err)
		}
		workload, workloadErr := azidentity.NewWorkloadIdentityCredential(nil)
		sources = []azcore.TokenCredential{managed, workload}
		sources[1] = configuredCredential("workload identity", sources[1], workloadErr)
		strategy = "managed identity, then workload identity"
	default:
		return nil, "", fmt.Errorf("unsupported environment %q", current)
	}

	credential, err := azidentity.NewChainedTokenCredential(sources, nil)
	if err != nil {
		return nil, "", fmt.Errorf("create chained token credential: %w", err)
	}
	return credential, strategy, nil
}

func configuredCredential(name string, credential azcore.TokenCredential, err error) azcore.TokenCredential {
	if err == nil {
		return credential
	}
	return unavailableCredential{name: name, cause: err}
}

func describeAuthenticationError(err error) error {
	var authenticationFailed *azidentity.AuthenticationFailedError
	if errors.As(err, &authenticationFailed) {
		status := 0
		if authenticationFailed.RawResponse != nil {
			status = authenticationFailed.RawResponse.StatusCode
		}
		return fmt.Errorf("authentication failed (HTTP status %d): %w", status, authenticationFailed)
	}
	var responseError *azcore.ResponseError
	if errors.As(err, &responseError) {
		return fmt.Errorf("token endpoint rejected authentication (status=%d code=%s): %w", responseError.StatusCode, responseError.ErrorCode, err)
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "tenant"):
		return fmt.Errorf("authentication failed due to tenant configuration: %w", err)
	case strings.Contains(message, "certificate") || strings.Contains(message, "expired"):
		return fmt.Errorf("authentication failed due to certificate or credential expiry: %w", err)
	case strings.Contains(message, "unavailable") || strings.Contains(message, "identity"):
		return fmt.Errorf("authentication failed because no configured identity was available: %w", err)
	default:
		return fmt.Errorf("authentication failed: %w", err)
	}
}

func anyEnvironment(names ...string) bool {
	for _, name := range names {
		if os.Getenv(name) != "" {
			return true
		}
	}
	return false
}
