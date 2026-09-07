package com.example;

import com.azure.core.exception.HttpResponseException;
import com.azure.core.exception.ResourceNotFoundException;
import com.azure.security.keyvault.secrets.SecretAsyncClient;
import com.azure.security.keyvault.secrets.SecretClient;
import com.azure.security.keyvault.secrets.models.KeyVaultSecret;
import reactor.core.publisher.Mono;

public final class SecretProviders {
    private SecretProviders() {
    }

    public static final class SyncProvider {
        private final SecretClient client;

        public SyncProvider(SecretClient client) {
            this.client = client;
        }

        public ConfigSecret get(
                String name,
                String version,
                String defaultValue) {
            try {
                KeyVaultSecret secret = client.getSecret(name, version);
                return new ConfigSecret(
                        secret.getValue(),
                        secret.getProperties().getExpiresOn());
            } catch (ResourceNotFoundException exception) {
                return new ConfigSecret(defaultValue, null);
            } catch (HttpResponseException exception) {
                reportFailure("retrieve", name, exception);
                throw exception;
            }
        }
    }

    public static final class AsyncProvider {
        private final SecretAsyncClient client;

        public AsyncProvider(SecretAsyncClient client) {
            this.client = client;
        }

        public Mono<ConfigSecret> get(
                String name,
                String version,
                String defaultValue) {
            return client.getSecret(name, version)
                    .map(secret -> new ConfigSecret(
                            secret.getValue(),
                            secret.getProperties().getExpiresOn()))
                    .doOnError(error -> {
                        if (!(error instanceof ResourceNotFoundException)) {
                            reportFailure("retrieve", name, error);
                        }
                    })
                    .onErrorResume(
                            ResourceNotFoundException.class,
                            exception -> Mono.just(
                                    new ConfigSecret(defaultValue, null)));
        }
    }

    static void reportFailure(String operation, String name, Throwable error) {
        if (error instanceof HttpResponseException responseException
                && responseException.getResponse() != null) {
            System.err.printf(
                    "Key Vault %s failed for secret %s: HTTP %d, %s%n",
                    operation,
                    name,
                    responseException.getResponse().getStatusCode(),
                    responseException.getMessage());
        } else {
            System.err.printf(
                    "Key Vault %s failed for secret %s: %s%n",
                    operation,
                    name,
                    error.getMessage());
        }
    }
}
