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

    public String roundTrip(String container, String blobName, String keyName, byte[] plaintext) {
        try {
            String keyId = keyClient.getKey(keyName).getId();
            CryptographyClient crypto = clients.cryptographyClient(keyId);
            byte[] dek = new byte[DEK_BYTES];
            byte[] iv = new byte[IV_BYTES];
            SecureRandom random = new SecureRandom();
            random.nextBytes(dek);
            random.nextBytes(iv);
            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");
            encryptor.init(Cipher.ENCRYPT_MODE, new javax.crypto.spec.SecretKeySpec(dek, "AES"),
                    new GCMParameterSpec(128, iv));
            byte[] ciphertext = encryptor.doFinal(plaintext);
            byte[] wrappedDek = crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek).getEncryptedKey();
            System.out.println("Wrapped DEK: " + Base64.getEncoder().encodeToString(wrappedDek));
            Map<String, String> metadata = new HashMap<>();
            metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrappedDek));
            metadata.put("iv", Base64.getEncoder().encodeToString(iv));
            metadata.put("vault-key-id", keyId);
            BlobClient blob = clients.blobServiceClient().getBlobContainerClient(container).getBlobClient(blobName);
            blob.uploadWithResponse(new BlobParallelUploadOptions(BinaryData.fromBytes(ciphertext)).setMetadata(metadata),
                    null, null);
            Map<String, String> stored = blob.getProperties().getMetadata();
            byte[] recoveredDek = crypto.unwrapKey(KeyWrapAlgorithm.RSA_OAEP,
                    Base64.getDecoder().decode(stored.get("wrapped-dek"))).getKey();
            Cipher decryptor = Cipher.getInstance("AES/GCM/NoPadding");
            decryptor.init(Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(recoveredDek, "AES"),
                    new GCMParameterSpec(128, Base64.getDecoder().decode(stored.get("iv"))));
            return new String(decryptor.doFinal(blob.downloadContent().toBytes()),
                    java.nio.charset.StandardCharsets.UTF_8);
        } catch (BlobStorageException exception) {
            System.err.println("Blob request failed: " + exception.getStatusCode());
            throw exception;
        } catch (HttpResponseException exception) {
            System.err.println("Key Vault request failed: " + exception.getResponse().getStatusCode());
            throw exception;
        } catch (Exception exception) {
            throw new IllegalStateException("Unable to complete encrypted blob round trip", exception);
        }
    }
}
