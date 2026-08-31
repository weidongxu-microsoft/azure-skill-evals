from __future__ import annotations

import base64
import secrets
from dataclasses import dataclass

from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
from azure.storage.blob import BlobServiceClient
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from key_manager import KeyManager


class BlobEncryptionError(Exception):
    """Raised when encrypted Blob Storage operations cannot be completed."""


@dataclass(frozen=True)
class EncryptionMetadata:
    wrapped_dek: str
    nonce: str
    key_id: str

    def as_blob_metadata(self) -> dict[str, str]:
        return {
            "wrapped_dek": self.wrapped_dek,
            "nonce": self.nonce,
            "key_id": self.key_id,
        }


class EncryptedBlobManager:
    def __init__(
        self,
        service_client: BlobServiceClient,
        key_manager: KeyManager,
        container_name: str,
        blob_name: str,
    ) -> None:
        self._blob_client = service_client.get_blob_client(
            container=container_name,
            blob=blob_name,
        )
        self._key_manager = key_manager

    def upload(self, plaintext: bytes) -> EncryptionMetadata:
        dek = self._key_manager.generate_data_encryption_key()
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(dek).encrypt(nonce, plaintext, None)
        wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)
        metadata = EncryptionMetadata(
            wrapped_dek=base64.b64encode(wrapped_dek).decode("ascii"),
            nonce=base64.b64encode(nonce).decode("ascii"),
            key_id=self._key_manager.key_id,
        )
        try:
            self._blob_client.upload_blob(
                ciphertext,
                overwrite=True,
                metadata=metadata.as_blob_metadata(),
            )
        except (ResourceNotFoundError, HttpResponseError) as error:
            raise BlobEncryptionError("Blob upload failed") from error
        return metadata

    def download(self) -> bytes:
        try:
            properties = self._blob_client.get_blob_properties()
            metadata = properties.metadata
            ciphertext = self._blob_client.download_blob().readall()
        except (ResourceNotFoundError, HttpResponseError) as error:
            raise BlobEncryptionError("Blob download failed") from error
        try:
            wrapped_dek = base64.b64decode(metadata["wrapped_dek"], validate=True)
            nonce = base64.b64decode(metadata["nonce"], validate=True)
            dek = self._key_manager.unwrap_data_encryption_key(wrapped_dek)
            return AESGCM(dek).decrypt(nonce, ciphertext, None)
        except (KeyError, ValueError) as error:
            raise BlobEncryptionError("Blob encryption metadata is invalid") from error
