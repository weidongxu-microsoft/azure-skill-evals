import os
import sys

from azure.appconfiguration import (
    AzureAppConfigurationClient,
    FeatureFlagConfigurationSetting,
)
from azure.core.exceptions import HttpResponseError
from azure.identity import DefaultAzureCredential


SETTING_KEY = "app:Settings:FontSize"


def main() -> int:
    endpoint = os.environ.get("AZURE_APPCONFIG_ENDPOINT")
    if not endpoint:
        print(
            "Set AZURE_APPCONFIG_ENDPOINT to the App Configuration endpoint.",
            file=sys.stderr,
        )
        return 2

    try:
        with DefaultAzureCredential() as credential:
            with AzureAppConfigurationClient(
                base_url=endpoint,
                credential=credential,
            ) as client:
                client.set_configuration_setting(key=SETTING_KEY, value="24")
                client.set_configuration_setting(
                    key=SETTING_KEY,
                    value="24",
                    label="Production",
                )

                setting = client.get_configuration_setting(key=SETTING_KEY)
                print(setting.value)

                for matching_setting in client.list_configuration_settings(
                    key_filter="app:Settings:*"
                ):
                    print(
                        f"{matching_setting.key}={matching_setting.value}"
                        f" (label={matching_setting.label!r})"
                    )

                client.set_configuration_setting(
                    FeatureFlagConfigurationSetting(
                        feature_id="BetaFeature",
                        enabled=True,
                    )
                )

                client.delete_configuration_setting(key=SETTING_KEY)
    except HttpResponseError as error:
        print(f"Azure App Configuration request failed: {error}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
