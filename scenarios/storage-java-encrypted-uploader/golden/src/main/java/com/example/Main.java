package com.example;

import java.nio.charset.StandardCharsets;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        AzureClients clients = new AzureClients(require("AZURE_STORAGE_ACCOUNT_URL"), require("AZURE_KEY_VAULT_URL"));
        String container = "encrypted-demo";
        String blobName = "message.bin";
        String keyName = require("AZURE_KEY_NAME");
        String keyId = clients.keyClient().getKey(keyName).getId();
        byte[] message = "client-side encrypted message".getBytes(StandardCharsets.UTF_8);

        String syncPlaintext = new SyncEncryptedBlobUploader(clients.keyClient(), clients)
                .roundTrip(container, blobName, keyName, message);
        System.out.println("Vault key ID: " + keyId);
        System.out.println("Wrapped DEK is stored as base64 metadata.");
        System.out.println("Sync decrypted output: " + syncPlaintext);

        String asyncPlaintext = new AsyncEncryptedBlobUploader(clients)
                .roundTrip(container, blobName + "-async", keyId, message)
                .block();
        System.out.println("Async decrypted output: " + asyncPlaintext);
    }

    private static String require(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
