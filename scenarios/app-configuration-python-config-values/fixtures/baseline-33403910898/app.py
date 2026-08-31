import os
import sys

from azure.appconfiguration import (
    AzureAppConfigurationClient,
    ConfigurationSetting,
    FeatureFlagConfigurationSetting,
)
from azure.core.exceptions import HttpResponseError


KEY = "app:Settings:FontSize"
KEY_FILTER = "app:Settings:*"


def main() -> None:
    connection_string = os.environ.get("AZURE_APP_CONFIG_CONNECTION_STRING")
    if not connection_string:
        raise RuntimeError(
            "Set the AZURE_APP_CONFIG_CONNECTION_STRING environment variable."
        )

    client = AzureAppConfigurationClient.from_connection_string(connection_string)

    try:
        client.set_configuration_setting(
            ConfigurationSetting(key=KEY, value="24")
        )
        client.set_configuration_setting(
            ConfigurationSetting(key=KEY, value="24", label="Production")
        )

        setting = client.get_configuration_setting(key=KEY)
        print(setting.value)

        for matching_setting in client.list_configuration_settings(
            key_filter=KEY_FILTER
        ):
            print(
                f"{matching_setting.key}={matching_setting.value} "
                f"(label={matching_setting.label!r})"
            )

        client.set_configuration_setting(
            FeatureFlagConfigurationSetting(
                feature_id="BetaFeature",
                enabled=True,
            )
        )

        client.delete_configuration_setting(key=KEY)
    except HttpResponseError as error:
        print(f"Azure App Configuration request failed: {error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
