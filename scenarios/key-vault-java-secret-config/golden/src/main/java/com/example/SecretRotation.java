package com.example;

import java.time.OffsetDateTime;

import com.azure.core.util.polling.PollerFlux;
import com.azure.core.util.polling.SyncPoller;
import com.azure.security.keyvault.secrets.SecretAsyncClient;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.models.DeletedSecret;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;
import reactor.core.publisher.Mono;

public final class SecretRotation {
    private SecretRotation() {
    }

    private static KeyVaultSecret replacement(
            String name,
            String value,
            OffsetDateTime expiresOn) {
        KeyVaultSecret secret = new KeyVaultSecret(name, value);
        secret.getProperties().setExpiresOn(expiresOn);
        return secret;
    }

    public static void rotateSync(
            SecretClient client,
            String name,
            String value,
            OffsetDateTime expiresOn) {
        SyncPoller<DeletedSecret, Void> poller =
                client.beginDeleteSecret(name);
        poller.waitForCompletion();
        client.purgeDeletedSecret(name);
        client.setSecret(replacement(name, value, expiresOn));
    }

    public static Mono<Void> rotateAsync(
            SecretAsyncClient client,
            String name,
            String value,
            OffsetDateTime expiresOn) {
        PollerFlux<DeletedSecret, Void> poller =
                client.beginDeleteSecret(name);
        return poller.last()
                .then(client.purgeDeletedSecret(name))
                .then(client.setSecret(
                        replacement(name, value, expiresOn)))
                .then();
    }
}
