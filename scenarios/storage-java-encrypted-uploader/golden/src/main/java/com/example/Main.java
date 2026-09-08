package com.example;

import java.nio.charset.StandardCharsets;

public final class Main {
    private Main() {
    }

    public static void main(String[] args) {
        AzureClients clients = AzureClients.fromEnvironment();
        String container = "encrypted-demo";
        String blobName = "message.bin";
        String keyName = require("AZURE_KEY_NAME");
        byte[] message = "client-side encrypted message".getBytes(StandardCharsets.UTF_8);

        System.out.println("Starting synchronous encrypted round trip");
        EncryptionResult syncResult = new SyncEncryptedBlobUploader(clients.keyClient(), clients)
                .roundTrip(container, blobName, keyName, message);
        printResult("Sync", syncResult);

        System.out.println("Starting asynchronous encrypted round trip");
        EncryptionResult asyncResult = new AsyncEncryptedBlobUploader(clients)
                .roundTrip(container, blobName + "-async", keyName, message)
                .block();
        printResult("Async", asyncResult);
    }

    private static void printResult(String implementation, EncryptionResult result) {
        System.out.println(implementation + " vault key ID: " + result.keyId());
        System.out.println(implementation + " wrapped DEK (base64): " + result.wrappedDekBase64());
        System.out.println(implementation + " decrypted output: " + result.plaintext());
    }

    private static String require(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Set " + name + " before running.");
        }
        return value;
    }
}
