package com.example;

public record EncryptionResult(
        String keyId,
        String wrappedDekBase64,
        String plaintext) {
}
