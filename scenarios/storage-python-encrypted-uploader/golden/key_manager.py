from __future__ import annotations

import secrets

from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
from azure.keyvault.keys.crypto import CryptographyClient, KeyWrapAlgorithm


class KeyVaultOperationError(Exception):
    """Raised when Key Vault cannot wrap or unwrap a data encryption key."""


class KeyManager:
    def __init__(self, crypto_client: CryptographyClient) -> None:
        self._crypto_client = crypto_client

    @property
    def key_id(self) -> str:
        return self._crypto_client.key_id

    @staticmethod
    def generate_data_encryption_key() -> bytes:
        return secrets.token_bytes(32)

    def wrap_data_encryption_key(self, dek: bytes) -> bytes:
        try:
            return self._crypto_client.wrap_key(
                KeyWrapAlgorithm.rsa_oaep,
                dek,
            ).encrypted_key
        except ResourceNotFoundError as error:
            raise KeyVaultOperationError("Key Vault could not wrap the DEK") from error
        except HttpResponseError as error:
            raise KeyVaultOperationError("Key Vault could not wrap the DEK") from error

    def unwrap_data_encryption_key(self, wrapped_dek: bytes) -> bytes:
        try:
            return self._crypto_client.unwrap_key(
                KeyWrapAlgorithm.rsa_oaep,
                wrapped_dek,
            ).key
        except ResourceNotFoundError as error:
            raise KeyVaultOperationError("Key Vault could not unwrap the DEK") from error
        except HttpResponseError as error:
            raise KeyVaultOperationError("Key Vault could not unwrap the DEK") from error
