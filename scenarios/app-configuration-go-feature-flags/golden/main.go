package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azappconfig"
)

const featureFlagPrefix = ".appconfig.featureflag/"

type cachedSetting struct {
	value string
	etag  azcore.ETag
}

type configurationService struct {
	client *azappconfig.Client
	mu     sync.RWMutex
	cache  map[string]cachedSetting
}

func newConfigurationService(client *azappconfig.Client) *configurationService {
	return &configurationService{client: client, cache: make(map[string]cachedSetting)}
}

func cacheKey(key, label string) string { return key + "\x00" + label }

func (service *configurationService) get(ctx context.Context, key, label string) (string, bool, error) {
	identifier := cacheKey(key, label)
	service.mu.RLock()
	cached, found := service.cache[identifier]
	service.mu.RUnlock()

	options := &azappconfig.GetSettingOptions{}
	if label != "" {
		options.Label = &label
	}
	if found {
		options.OnlyIfChanged = &cached.etag
	}

	response, err := service.client.GetSetting(ctx, key, options)
	if err != nil {
		var responseError *azcore.ResponseError
		if found && errors.As(err, &responseError) && responseError.StatusCode == 304 {
			return cached.value, false, nil
		}
		return "", false, fmt.Errorf("get setting %q: %w", key, err)
	}

	setting := cachedSetting{value: valueOrEmpty(response.Value)}
	if response.ETag != nil {
		setting.etag = *response.ETag
	}
	service.mu.Lock()
	service.cache[identifier] = setting
	service.mu.Unlock()
	return setting.value, !found || setting.value != cached.value || setting.etag != cached.etag, nil
}

func (service *configurationService) listPrefix(ctx context.Context, prefix string) (map[string]string, error) {
	filter := prefix + "*"
	pager := service.client.NewListSettingsPager(azappconfig.SettingSelector{KeyFilter: &filter}, nil)
	settings := make(map[string]string)
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("list settings for %q: %w", prefix, err)
		}
		service.mu.Lock()
		for _, setting := range page.Settings {
			key := valueOrEmpty(setting.Key)
			label := valueOrEmpty(setting.Label)
			value := valueOrEmpty(setting.Value)
			settings[key] = value
			entry := cachedSetting{value: value}
			if setting.ETag != nil {
				entry.etag = *setting.ETag
			}
			service.cache[cacheKey(key, label)] = entry
		}
		service.mu.Unlock()
	}
	return settings, nil
}

type featureFlag struct {
	ID         string `json:"id"`
	Enabled    bool   `json:"enabled"`
	Conditions struct {
		ClientFilters []struct {
			Name       string `json:"name"`
			Parameters struct {
				Value      float64 `json:"Value"`
				Percentage float64 `json:"Percentage"`
			} `json:"parameters"`
		} `json:"client_filters"`
	} `json:"conditions"`
}

func (service *configurationService) enabled(ctx context.Context, flagName, userID string) (bool, error) {
	value, _, err := service.get(ctx, featureFlagPrefix+flagName, "")
	if err != nil {
		return false, err
	}
	var flag featureFlag
	if err := json.Unmarshal([]byte(value), &flag); err != nil {
		return false, fmt.Errorf("parse feature flag %q: %w", flagName, err)
	}
	if !flag.Enabled {
		return false, nil
	}
	for _, filter := range flag.Conditions.ClientFilters {
		if filter.Name != "Microsoft.Percentage" && filter.Name != "Percentage" {
			continue
		}
		percentage := filter.Parameters.Value
		if percentage == 0 {
			percentage = filter.Parameters.Percentage
		}
		return rolloutBucket(flagName, userID) < percentage, nil
	}
	return true, nil
}

func rolloutBucket(flagName, userID string) float64 {
	digest := sha256.Sum256([]byte(flagName + ":" + userID))
	return float64(binary.BigEndian.Uint64(digest[:8])%10000) / 100
}

func (service *configurationService) watch(ctx context.Context, sentinels []string, interval time.Duration, refreshPrefix string) error {
	for _, sentinel := range sentinels {
		if _, _, err := service.get(ctx, sentinel, ""); err != nil {
			return err
		}
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			changed := false
			for _, sentinel := range sentinels {
				_, sentinelChanged, err := service.get(ctx, sentinel, "")
				if err != nil {
					return err
				}
				changed = changed || sentinelChanged
			}
			if changed {
				service.mu.Lock()
				service.cache = make(map[string]cachedSetting)
				service.mu.Unlock()
				if _, err := service.listPrefix(ctx, refreshPrefix); err != nil {
					return err
				}
			}
		}
	}
}

func run(ctx context.Context) error {
	endpoint := os.Getenv("AZURE_APPCONFIG_ENDPOINT")
	if endpoint == "" {
		return errors.New("AZURE_APPCONFIG_ENDPOINT is required")
	}
	credential, err := azidentity.NewDefaultAzureCredential(nil)
	if err != nil {
		return fmt.Errorf("create credential: %w", err)
	}
	client, err := azappconfig.NewClient(endpoint, credential, nil)
	if err != nil {
		return fmt.Errorf("create App Configuration client: %w", err)
	}
	service := newConfigurationService(client)
	value, _, err := service.get(ctx, "app:Settings:FontSize", "production")
	if err != nil {
		return err
	}
	fmt.Println("production font size:", value)
	settings, err := service.listPrefix(ctx, "app:Settings:")
	if err != nil {
		return err
	}
	fmt.Println("settings:", settings)
	for _, userID := range []string{"alice", "bob", "carol"} {
		enabled, flagErr := service.enabled(ctx, "BetaFeature", userID)
		if flagErr != nil {
			return flagErr
		}
		fmt.Printf("BetaFeature user=%s enabled=%t\n", userID, enabled)
	}
	return service.watch(ctx, []string{"app:Sentinel"}, 30*time.Second, "app:")
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		var responseError *azcore.ResponseError
		if errors.As(err, &responseError) {
			fmt.Fprintf(os.Stderr, "Azure request failed: status=%d code=%s\n", responseError.StatusCode, responseError.ErrorCode)
		} else {
			fmt.Fprintln(os.Stderr, err)
		}
		os.Exit(1)
	}
}
