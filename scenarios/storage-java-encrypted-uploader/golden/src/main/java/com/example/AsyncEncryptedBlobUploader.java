package com.example;

import com.azure.core.util.BinaryData;
import com.azure.core.exception.HttpResponseException;
import com.azure.security.keyvault.keys.cryptography.CryptographyAsyncClient;
import com.azure.security.keyvault.keys.cryptography.models.KeyWrapAlgorithm;
import com.azure.storage.blob.BlobAsyncClient;
import com.azure.storage.blob.models.BlobStorageException;
import com.azure.storage.blob.options.BlobParallelUploadOptions;
import reactor.core.publisher.Mono;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

public final class AsyncEncryptedBlobUploader {
    private final AzureClients clients;

    public AsyncEncryptedBlobUploader(AzureClients clients) {
        this.clients = clients;
    }

    public Mono<String> roundTrip(String container, String blobName, String keyId, byte[] plaintext) {
        CryptographyAsyncClient crypto = clients.cryptographyAsyncClient(keyId);
        BlobAsyncClient blob = clients.blobServiceAsyncClient()
                .getBlobContainerAsyncClient(container).getBlobAsyncClient(blobName);
        byte[] dek = new byte[32];
        byte[] iv = new byte[12];
        SecureRandom random = new SecureRandom();
        random.nextBytes(dek);
        random.nextBytes(iv);
        try {
            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");
            encryptor.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(dek, "AES"), new GCMParameterSpec(128, iv));
            byte[] ciphertext = encryptor.doFinal(plaintext);
            return crypto.wrapKey(KeyWrapAlgorithm.RSA_OAEP, dek)
                    .flatMap(wrapped -> {
                        Map<String, String> metadata = new HashMap<>();
                        metadata.put("wrapped-dek", Base64.getEncoder().encodeToString(wrapped.getEncryptedKey()));
                        metadata.put("iv", Base64.getEncoder().encodeToString(iv));
                        metadata.put("vault-key-id", keyId);
                        return blob.uploadWithResponse(new BlobParallelUploadOptions(BinaryData.fromBytes(ciphertext))
                                        .setMetadata(metadata))
                                .then(blob.getProperties())
                                .flatMap(properties -> crypto.unwrapKey(KeyWrapAlgorithm.RSA_OAEP,
                                        Base64.getDecoder().decode(properties.getMetadata().get("wrapped-dek")))
                                        .flatMap(unwrapped -> blob.downloadContent().map(content -> decrypt(
                                                content.toBytes(), unwrapped.getKey(),
                                                Base64.getDecoder().decode(properties.getMetadata().get("iv"))))));
                    })
                    .onErrorMap(BlobStorageException.class, exception -> {
                        System.err.println("Blob request failed: " + exception.getStatusCode());
                        return exception;
                    })
                    .onErrorMap(HttpResponseException.class, exception -> {
                        System.err.println("Key Vault request failed: " + exception.getResponse().getStatusCode());
                        return exception;
                    });
        } catch (Exception exception) {
            return Mono.error(new IllegalStateException("Unable to encrypt blob content", exception));
        }
    }

    private String decrypt(byte[] ciphertext, byte[] dek, byte[] iv) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(dek, "AES"), new GCMParameterSpec(128, iv));
            return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        } catch (Exception exception) {
            throw new IllegalStateException("Unable to decrypt blob content", exception);
        }
    }
}
