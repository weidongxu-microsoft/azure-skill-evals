package com.example;

import com.azure.core.util.BinaryData;
import com.azure.core.exception.HttpResponseException;
import com.azure.security.keyvault.keys.cryptography.CryptographyClient;
import com.azure.security.keyvault.keys.KeyClient;
import com.azure.security.keyvault.keys.cryptography.models.KeyWrapAlgorithm;
import com.azure.storage.blob.BlobClient;
import com.azure.storage.blob.models.BlobStorageException;
import com.azure.storage.blob.options.BlobParallelUploadOptions;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

public final class SyncEncryptedBlobUploader {
    private static final int DEK_BYTES = 32;
    private static final int IV_BYTES = 12;
    private final KeyClient keyClient;
    private final AzureClients clients;

    public SyncEncryptedBlobUploader(KeyClient keyClient, AzureClients clients) {
        this.keyClient = keyClient;
        this.clients = clients;
    }

    public EncryptionResult roundTrip(
            String container,
            String blobName,
            String keyName,
            byte[] plaintext) {
        byte[] dek = new byte[DEK_BYTES];
        byte[] recoveredDek = null;
        try {
            String keyId = keyClient.getKey(keyName).getId();
            CryptographyClient crypto = clients.cryptographyClient(keyId);
            byte[] iv = new byte[IV_BYTES];
            SecureRandom random = new SecureRandom();
            random.nextBytes(dek);
            random.nextBytes(iv);
            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");
            encryptor.init(Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(dek, "AES"),
                    new GCMParameterSpec(128, iv));
            byte[] ciphertext = encryptor.doFinal(plaintext);
            byte[] wrappedDek = crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek).getEncryptedKey();
            String wrappedDekBase64 = Base64.getEncoder().encodeToString(wrappedDek);
            Map<String, String> metadata = new HashMap<>();
            metadata.put("wrapped_dek", wrappedDekBase64);
            metadata.put("iv", Base64.getEncoder().encodeToString(iv));
            metadata.put("vault_key_id", keyId);
            metadata.put("content_encryption_algorithm", "AES/GCM/NoPadding");
            metadata.put("key_wrap_algorithm", KeyWrapAlgorithm.RSA_OAEP.toString());
            BlobClient blob = clients.blobServiceClient().getBlobContainerClient(container).getBlobClient(blobName);
            blob.uploadWithResponse(new BlobParallelUploadOptions(BinaryData.fromBytes(ciphertext)).setMetadata(metadata),
                    null, null);
            Map<String, String> stored = blob.getProperties().getMetadata();
            recoveredDek = crypto.unwrapKey(KeyWrapAlgorithm.RSA_OAEP,
                    Base64.getDecoder().decode(stored.get("wrapped_dek"))).getKey();
            Cipher decryptor = Cipher.getInstance("AES/GCM/NoPadding");
            decryptor.init(Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(recoveredDek, "AES"),
                    new GCMParameterSpec(128, Base64.getDecoder().decode(stored.get("iv"))));
            String decrypted = new String(
                    decryptor.doFinal(blob.downloadContent().toBytes()),
                    java.nio.charset.StandardCharsets.UTF_8);
            return new EncryptionResult(keyId, wrappedDekBase64, decrypted);
        } catch (BlobStorageException exception) {
            System.err.printf(
                    "Blob request failed: status=%d code=%s message=%s%n",
                    exception.getStatusCode(),
                    exception.getErrorCode(),
                    exception.getMessage());
            throw exception;
        } catch (HttpResponseException exception) {
            int status = exception.getResponse() == null
                    ? -1
                    : exception.getResponse().getStatusCode();
            System.err.printf(
                    "Key Vault key request failed: status=%d message=%s. "
                            + "Verify that the key exists and is enabled.%n",
                    status,
                    exception.getMessage());
            throw exception;
        } catch (Exception exception) {
            throw new IllegalStateException("Unable to complete encrypted blob round trip", exception);
        } finally {
            Arrays.fill(dek, (byte) 0);
            if (recoveredDek != null) {
                Arrays.fill(recoveredDek, (byte) 0);
            }
        }
    }
}
