package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
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
	vaultURL, err := requiredEnvironment("AZURE_KEY_VAULT_URL")
	if err != nil {
		return err
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create credential: %w", err)
	}
	client, err := azsecrets.NewClient(vaultURL, credential, &azsecrets.ClientOptions{
		ClientOptions: azcore.ClientOptions{Retry: policy.RetryOptions{
			MaxRetries:    5,
			TryTimeout:    30 * time.Second,
			RetryDelay:    time.Second,
			MaxRetryDelay: 16 * time.Second,
		}},
	})
	if err != nil {
		return fmt.Errorf("create secrets client: %w", err)
	}

	secretName := environmentOr("AZURE_KEY_VAULT_SECRET_NAME", "sample-secret")
	switch environmentOr("AZURE_KEY_VAULT_ACTION", "get") {
	case "get":
		return getSecret(ctx, client, secretName)
	case "set":
		return setSecret(ctx, client, secretName)
	case "purge":
		return purgeSecret(ctx, client, secretName)
	default:
		return errors.New("AZURE_KEY_VAULT_ACTION must be get, set, or purge")
	}
}

func getSecret(ctx context.Context, client *azsecrets.Client, name string) error {
	response, err := client.GetSecret(ctx, name, "", nil)
	if err == nil {
		fmt.Printf("read secret metadata for %q; value intentionally not logged\n", response.ID.Name())
		return nil
	}
	responseError, ok := reportResponseError("get secret", err)
	if !ok {
		return fmt.Errorf("get secret: %w", err)
	}
	switch responseError.StatusCode {
	case http.StatusForbidden:
		fmt.Fprintln(os.Stderr, "access denied: verify the caller's Key Vault RBAC role assignment or legacy access policy")
		return nil
	case http.StatusNotFound:
		return diagnoseMissingSecret(ctx, client, name)
	case http.StatusTooManyRequests:
		fmt.Fprintln(os.Stderr, "Key Vault throttled the request after the configured SDK retries were exhausted")
		return nil
	default:
		return fmt.Errorf("get secret: %w", err)
	}
}

func setSecret(ctx context.Context, client *azsecrets.Client, name string) error {
	value, err := requiredEnvironment("AZURE_KEY_VAULT_SECRET_VALUE")
	if err != nil {
		return err
	}
	_, err = client.SetSecret(ctx, name, azsecrets.SetSecretParameters{Value: &value}, nil)
	if err == nil {
		fmt.Printf("stored a new version of secret %q\n", name)
		return nil
	}
	responseError, ok := reportResponseError("set secret", err)
	if !ok {
		return fmt.Errorf("set secret: %w", err)
	}
	if responseError.StatusCode == http.StatusConflict {
		fmt.Fprintln(os.Stderr, "conflict: a concurrent operation or a soft-deleted secret name may require recovery or purge before reuse")
		return nil
	}
	if responseError.StatusCode == http.StatusTooManyRequests {
		fmt.Fprintln(os.Stderr, "Key Vault throttled the request after the configured SDK retries were exhausted")
		return nil
	}
	return fmt.Errorf("set secret: %w", err)
}

func diagnoseMissingSecret(ctx context.Context, client *azsecrets.Client, name string) error {
	_, err := client.GetDeletedSecret(ctx, name, nil)
	if err == nil {
		fmt.Fprintf(os.Stderr, "secret %q is soft-deleted and recoverable\n", name)
		return nil
	}
	var responseError *azcore.ResponseError
	if errors.As(err, &responseError) && responseError.StatusCode == http.StatusNotFound {
		fmt.Fprintf(os.Stderr, "secret %q does not exist and is not soft-deleted\n", name)
		return nil
	}
	return fmt.Errorf("check deleted secret: %w", err)
}

func purgeSecret(ctx context.Context, client *azsecrets.Client, name string) error {
	_, err := client.PurgeDeletedSecret(ctx, name, nil)
	if err == nil {
		fmt.Printf("purged deleted secret %q\n", name)
		return nil
	}
	responseError, ok := reportResponseError("purge deleted secret", err)
	if !ok {
		return fmt.Errorf("purge deleted secret: %w", err)
	}
	if responseError.StatusCode == http.StatusForbidden || responseError.StatusCode == http.StatusConflict {
		fmt.Fprintln(os.Stderr, "purge failed: verify purge permission; purge protection prevents permanent deletion until retention expires")
		return nil
	}
	return fmt.Errorf("purge deleted secret: %w", err)
}

func reportResponseError(operation string, err error) (*azcore.ResponseError, bool) {
	var responseError *azcore.ResponseError
	if !errors.As(err, &responseError) {
		return nil, false
	}
	retryAfter, retryAfterMS := "", ""
	if responseError.RawResponse != nil {
		retryAfter = responseError.RawResponse.Header.Get("Retry-After")
		retryAfterMS = responseError.RawResponse.Header.Get("x-ms-retry-after-ms")
	}
	fmt.Fprintf(os.Stderr, "%s failed: status=%d code=%s retry-after=%q retry-after-ms=%q\n", operation, responseError.StatusCode, responseError.ErrorCode, retryAfter, retryAfterMS)
	return responseError, true
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
