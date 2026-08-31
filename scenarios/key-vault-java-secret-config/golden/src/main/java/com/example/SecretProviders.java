package com.example;

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
                    .onErrorResume(
                            ResourceNotFoundException.class,
                            exception -> Mono.just(
                                    new ConfigSecret(defaultValue, null)));
        }
    }
}
