from __future__ import annotations

import os
import sys

from azure.core.exceptions import ClientAuthenticationError
from azure.identity import ClientSecretCredential
from azure.keyvault.secrets import SecretClient


def main() -> int:
    tenant_id = os.environ["AZURE_TENANT_ID"]
    client_id = os.environ["AZURE_CLIENT_ID"]
    client_secret = os.environ["AZURE_CLIENT_SECRET"]
    vault_url = os.environ["AZURE_KEY_VAULT_URL"]
    secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]

    credential = ClientSecretCredential(
        tenant_id=tenant_id,
        client_id=client_id,
        client_secret=client_secret,
    )

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

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
