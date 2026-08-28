from __future__ import annotations

import secrets

from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
from azure.keyvault.keys.crypto import KeyWrapAlgorithm
from azure.keyvault.keys.crypto.aio import CryptographyClient

from key_manager import KeyVaultOperationError


class AsyncKeyManager:
    def __init__(self, crypto_client: CryptographyClient) -> None:
        self._crypto_client = crypto_client

    @property
    def key_id(self) -> str:
        return self._crypto_client.key_id

    @staticmethod
    def generate_data_encryption_key() -> bytes:
        return secrets.token_bytes(32)

    async def wrap_data_encryption_key(self, dek: bytes) -> bytes:
        try:
            result = await self._crypto_client.wrap_key(
                KeyWrapAlgorithm.rsa_oaep,
                dek,
            )
            return result.encrypted_key
        except (ResourceNotFoundError, HttpResponseError) as error:
            raise KeyVaultOperationError("Key Vault could not wrap the DEK") from error

    async def unwrap_data_encryption_key(self, wrapped_dek: bytes) -> bytes:
        try:
            result = await self._crypto_client.unwrap_key(
                KeyWrapAlgorithm.rsa_oaep,
                wrapped_dek,
            )
            return result.key
        except (ResourceNotFoundError, HttpResponseError) as error:
            raise KeyVaultOperationError("Key Vault could not unwrap the DEK") from error
