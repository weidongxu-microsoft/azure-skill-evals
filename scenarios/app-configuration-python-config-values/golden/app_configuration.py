import os

from azure.appconfiguration import (
    AzureAppConfigurationClient,
    ConfigurationSetting,
    FeatureFlagConfigurationSetting,
)
from azure.core.exceptions import HttpResponseError
from azure.identity import DefaultAzureCredential


def main() -> None:
    endpoint = os.environ["AZURE_APPCONFIGURATION_ENDPOINT"]
    credential = DefaultAzureCredential()

    try:
        with AzureAppConfigurationClient(
            base_url=endpoint,
            credential=credential,
        ) as client:
            key = "app:Settings:FontSize"
            client.set_configuration_setting(
                ConfigurationSetting(key=key, value="24")
            )
            client.set_configuration_setting(
                ConfigurationSetting(
                    key=key,
                    value="24",
                    label="Production",
                )
            )

            setting = client.get_configuration_setting(key=key)
            print(setting.value)

            for matching_setting in client.list_configuration_settings(
                key_filter="app:Settings:*"
            ):
                print(f"{matching_setting.key}={matching_setting.value}")

            client.set_configuration_setting(
                FeatureFlagConfigurationSetting(
                    feature_id="BetaFeature",
                    enabled=True,
                )
            )
            client.delete_configuration_setting(key=key)
    except HttpResponseError as exception:
        print(f"App Configuration request failed: {exception}", file=os.sys.stderr)
        raise
    finally:
        credential.close()


if __name__ == "__main__":
    main()
