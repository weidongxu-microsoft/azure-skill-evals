package com.example;

import com.azure.core.util.BinaryData;
import com.azure.core.exception.HttpResponseException;
import com.azure.security.keyvault.keys.cryptography.CryptographyAsyncClient;
import com.azure.security.keyvault.keys.cryptography.models.KeyWrapAlgorithm;
import com.azure.storage.blob.BlobAsyncClient;
import com.azure.storage.blob.models.BlobStorageException;
import com.azure.storage.blob.options.BlobParallelUploadOptions;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;

public final class AsyncEncryptedBlobUploader {
    private final AzureClients clients;

    public AsyncEncryptedBlobUploader(AzureClients clients) {
        this.clients = clients;
    }

    public Mono<EncryptionResult> roundTrip(
            String container,
            String blobName,
            String keyName,
            byte[] plaintext) {
        return clients.keyAsyncClient()
                .getKey(keyName)
                .flatMap(key -> encryptAndUpload(
                        container,
                        blobName,
                        key.getId(),
                        plaintext))
                .onErrorMap(
                        exception -> exception instanceof HttpResponseException
                                && !(exception instanceof BlobStorageException),
                        exception -> reportKeyVaultFailure(
                                (HttpResponseException) exception));
    }

    private Mono<EncryptionResult> encryptAndUpload(
            String container,
            String blobName,
            String keyId,
            byte[] plaintext) {
        CryptographyAsyncClient crypto = clients.cryptographyAsyncClient(keyId);
        BlobAsyncClient blob = clients.blobServiceAsyncClient()
                .getBlobContainerAsyncClient(container)
                .getBlobAsyncClient(blobName);
        return Mono.fromCallable(() -> encryptLocally(plaintext))
                .subscribeOn(Schedulers.boundedElastic())
                .flatMap(encrypted -> crypto
                    .wrapKey(KeyWrapAlgorithm.RSA_OAEP, encrypted.dek())
                    .doFinally(signal -> Arrays.fill(encrypted.dek(), (byte) 0))
                    .flatMap(wrapped -> {
                        String wrappedDekBase64 =
                                Base64.getEncoder().encodeToString(wrapped.getEncryptedKey());
                        Map<String, String> metadata = new HashMap<>();
                        metadata.put("wrapped_dek", wrappedDekBase64);
                        metadata.put(
                                "iv",
                                Base64.getEncoder().encodeToString(encrypted.iv()));
                        metadata.put("vault_key_id", keyId);
                        metadata.put("content_encryption_algorithm", "AES/GCM/NoPadding");
                        metadata.put("key_wrap_algorithm", KeyWrapAlgorithm.RSA_OAEP.toString());
                        return blob.uploadWithResponse(new BlobParallelUploadOptions(
                                        BinaryData.fromBytes(encrypted.ciphertext()))
                                        .setMetadata(metadata))
                                .then(blob.getProperties())
                               .flatMap(properties -> {
                                   Map<String, String> storedMetadata = properties.getMetadata();
                                   String storedKeyId = requireMetadata(storedMetadata, "vault_key_id");
                                   CryptographyAsyncClient unwrapCrypto =
                                           clients.cryptographyAsyncClient(storedKeyId);
                                   return unwrapCrypto
                                           .unwrapKey(
                                                   KeyWrapAlgorithm.RSA_OAEP,
                                                   Base64.getDecoder().decode(
                                                           storedMetadata.get("wrapped_dek")))
                                           .flatMap(unwrapped -> blob.downloadContent()
                                                   .flatMap(content -> decryptOffThread(
                                                           storedKeyId,
                                                           wrappedDekBase64,
                                                           content.toBytes(),
                                                           unwrapped.getKey(),
                                                           Base64.getDecoder().decode(
                                                                   storedMetadata.get("iv")))));
                               });
                    })
                    .onErrorMap(BlobStorageException.class, exception -> {
                        System.err.printf(
                                "Blob request failed: status=%d code=%s message=%s%n",
                                exception.getStatusCode(),
                                exception.getErrorCode(),
                                exception.getMessage());
                        return exception;
                    }));
    }

    private LocalEncryption encryptLocally(byte[] plaintext) throws Exception {
        byte[] dek = new byte[32];
        byte[] iv = new byte[12];
        SecureRandom random = new SecureRandom();
        random.nextBytes(dek);
        random.nextBytes(iv);
        try {
            Cipher encryptor = Cipher.getInstance("AES/GCM/NoPadding");
            encryptor.init(
                    Cipher.ENCRYPT_MODE,
                    new SecretKeySpec(dek, "AES"),
                    new GCMParameterSpec(128, iv));
            return new LocalEncryption(dek, iv, encryptor.doFinal(plaintext));
        } catch (Exception exception) {
            Arrays.fill(dek, (byte) 0);
            throw exception;
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

    private HttpResponseException reportKeyVaultFailure(HttpResponseException exception) {
        int status = exception.getResponse() == null
                ? -1
                : exception.getResponse().getStatusCode();
        System.err.printf(
                "Key Vault key request failed: status=%d message=%s. "
                        + "Verify that the key exists and is enabled.%n",
                status,
                exception.getMessage());
        return exception;
    }

    private static String requireMetadata(Map<String, String> metadata, String name) {
        String value = metadata.get(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Missing required encryption metadata: " + name);
        }
        return value;
    }

    private Mono<EncryptionResult> decryptOffThread(
            String keyId,
            String wrappedDekBase64,
            byte[] ciphertext,
            byte[] recoveredDek,
            byte[] iv) {
        return Mono.fromCallable(() -> new EncryptionResult(
                        keyId,
                        wrappedDekBase64,
                        decrypt(ciphertext, recoveredDek, iv)))
                .subscribeOn(Schedulers.boundedElastic())
                .doFinally(signal -> Arrays.fill(recoveredDek, (byte) 0));
    }

    private record LocalEncryption(byte[] dek, byte[] iv, byte[] ciphertext) {
    }
}
