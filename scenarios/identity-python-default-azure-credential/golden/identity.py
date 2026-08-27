from __future__ import annotations

import logging
import os
import sys

from azure.core.exceptions import ClientAuthenticationError, HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient


def configure_identity_diagnostics() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    logging.getLogger("azure.identity").setLevel(logging.INFO)


def run() -> int:
    vault_url = os.environ["AZURE_KEY_VAULT_URL"]
    secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
    credential = DefaultAzureCredential()

    try:
        with credential:
            with SecretClient(
                vault_url=vault_url,
                credential=credential,
            ) as client:
                secret = client.get_secret(secret_name)
                print(secret.value)
    except ClientAuthenticationError as error:
        print(f"Azure authentication failed: {error}", file=sys.stderr)
        return 1
    except HttpResponseError as error:
        print(f"Key Vault request failed: {error}", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    configure_identity_diagnostics()
    try:
        return run()
    except KeyError as error:
        print(
            f"Missing required environment variable: {error.args[0]}",
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
