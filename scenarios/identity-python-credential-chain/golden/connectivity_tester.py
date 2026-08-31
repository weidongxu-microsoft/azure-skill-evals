from __future__ import annotations

from azure.core.exceptions import ClientAuthenticationError
from azure.core.credentials import TokenCredential
from azure.core.credentials_async import AsyncTokenCredential

ARM_SCOPE = "https://management.azure.com/.default"


def test_sync(credential: TokenCredential) -> bool:
    try:
        token = credential.get_token(ARM_SCOPE, enable_cae=True)
        print(f"Sync token expires at Unix time {token.expires_on}")
        return True
    except ClientAuthenticationError as error:
        print(f"Sync authentication failed: {error}")
        return False


async def test_async(credential: AsyncTokenCredential) -> bool:
    try:
        token = await credential.get_token(ARM_SCOPE, enable_cae=True)
        print(f"Async token expires at Unix time {token.expires_on}")
        return True
    except ClientAuthenticationError as error:
        print(f"Async authentication failed: {error}")
        return False
