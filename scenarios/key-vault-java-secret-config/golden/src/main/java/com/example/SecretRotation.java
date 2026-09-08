package com.example;

import java.time.Duration;
import java.time.OffsetDateTime;

import com.azure.core.exception.ResourceNotFoundException;
import com.azure.core.util.polling.PollerFlux;
import com.azure.core.util.polling.SyncPoller;
import com.azure.security.keyvault.secrets.SecretAsyncClient;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.models.DeletedSecret;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;
import reactor.core.publisher.Mono;

public final class SecretRotation {
    private static final int REUSE_CHECK_ATTEMPTS = 30;
    private static final Duration REUSE_CHECK_DELAY = Duration.ofSeconds(2);

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
        try {
            SyncPoller<DeletedSecret, Void> poller =
                    client.beginDeleteSecret(name);
            poller.waitForCompletion();
            client.purgeDeletedSecret(name);
            waitUntilNameIsReusable(client, name);
            client.setSecret(replacement(name, value, expiresOn));
        } catch (RuntimeException exception) {
            SecretProviders.reportFailure("rotate", name, exception);
            throw exception;
        }
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
                .then(waitUntilNameIsReusable(client, name, REUSE_CHECK_ATTEMPTS))
                .then(client.setSecret(
                        replacement(name, value, expiresOn)))
                .doOnError(error ->
                        SecretProviders.reportFailure("rotate", name, error))
                .then();
    }

    private static void waitUntilNameIsReusable(
            SecretClient client,
            String name) {
        for (int attempt = 1; attempt <= REUSE_CHECK_ATTEMPTS; attempt++) {
            try {
                client.getDeletedSecret(name);
            } catch (ResourceNotFoundException purged) {
                return;
            }
            try {
                Thread.sleep(REUSE_CHECK_DELAY.toMillis());
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(
                        "Interrupted while waiting to recreate secret " + name,
                        interrupted);
            }
        }
        throw new IllegalStateException(
                "Secret name is still reserved after completed purge: " + name);
    }

    private static Mono<Void> waitUntilNameIsReusable(
            SecretAsyncClient client,
            String name,
            int attemptsRemaining) {
        return client.getDeletedSecret(name)
                .flatMap(ignored -> {
                    if (attemptsRemaining <= 1) {
                        return Mono.<Void>error(new IllegalStateException(
                                "Secret name is still reserved after completed purge: "
                                        + name));
                    }
                    return Mono.delay(REUSE_CHECK_DELAY)
                            .then(waitUntilNameIsReusable(
                                    client,
                                    name,
                                    attemptsRemaining - 1));
                })
                .then()
                .onErrorResume(
                        ResourceNotFoundException.class,
                        purged -> Mono.empty());
    }
}
