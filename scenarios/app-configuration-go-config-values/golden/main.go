package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azappconfig"
)

const (
	settingKey             = "app:Settings:FontSize"
	productionLabel        = "Production"
	featureFlagKey         = ".appconfig.featureflag/BetaFeature"
	featureFlagContentType = "application/vnd.microsoft.appconfig.ff+json;charset=utf-8"
)

func run(ctx context.Context) error {
	connectionString := os.Getenv("AZURE_APPCONFIG_CONNECTION_STRING")
	if connectionString == "" {
		return errors.New("AZURE_APPCONFIG_CONNECTION_STRING is required")
	}

	client, err := azappconfig.NewClientFromConnectionString(connectionString, nil)
	if err != nil {
		return fmt.Errorf("create App Configuration client: %w", err)
	}

	value := "24"
	if _, err = client.SetSetting(ctx, settingKey, &value, nil); err != nil {
		return fmt.Errorf("set setting: %w", err)
	}
	if _, err = client.SetSetting(ctx, settingKey, &value, &azappconfig.SetSettingOptions{Label: stringPtr(productionLabel)}); err != nil {
		return fmt.Errorf("set labeled setting: %w", err)
	}

	setting, err := client.GetSetting(ctx, settingKey, &azappconfig.GetSettingOptions{Label: stringPtr(productionLabel)})
	if err != nil {
		return fmt.Errorf("get labeled setting: %w", err)
	}
	fmt.Println(*setting.Value)

	keyFilter := "app:Settings:*"
	pager := client.NewListSettingsPager(azappconfig.SettingSelector{KeyFilter: &keyFilter}, nil)
	for pager.More() {
		page, pageErr := pager.NextPage(ctx)
		if pageErr != nil {
			return fmt.Errorf("list settings: %w", pageErr)
		}
		for _, item := range page.Settings {
			fmt.Printf("%s=%s\n", valueOrEmpty(item.Key), valueOrEmpty(item.Value))
		}
	}

	flagValue := `{"id":"BetaFeature","description":"","enabled":true,"conditions":{"client_filters":[]}}`
	if _, err = client.SetSetting(ctx, featureFlagKey, &flagValue, &azappconfig.SetSettingOptions{ContentType: stringPtr(featureFlagContentType)}); err != nil {
		return fmt.Errorf("set feature flag: %w", err)
	}

	if _, err = client.DeleteSetting(ctx, settingKey, &azappconfig.DeleteSettingOptions{Label: stringPtr(productionLabel)}); err != nil {
		return fmt.Errorf("delete labeled setting: %w", err)
	}
	if _, err = client.DeleteSetting(ctx, settingKey, nil); err != nil {
		return fmt.Errorf("delete setting: %w", err)
	}
	return nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func stringPtr(value string) *string {
	return &value
}

func main() {
	if err := run(context.Background()); err != nil {
		var responseError *azcore.ResponseError
		if errors.As(err, &responseError) {
			fmt.Fprintf(os.Stderr, "Azure request failed: status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
