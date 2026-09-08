package com.example;

import com.azure.core.http.policy.HttpLogDetailLevel;
import com.azure.core.http.policy.HttpLogOptions;
import com.azure.core.credential.TokenCredential;
import com.azure.identity.ManagedIdentityCredentialBuilder;
import com.azure.storage.blob.BlobServiceAsyncClient;
import com.azure.storage.blob.BlobServiceClient;
import com.azure.storage.blob.BlobServiceClientBuilder;
import com.azure.storage.common.policy.RequestRetryOptions;
import com.azure.storage.common.policy.RetryPolicyType;

import java.time.Duration;

public final class BlobStorageConfiguration {
    private final String endpoint;
    private final TokenCredential managedIdentityCredential;
    private final int maxRetries;
    private final Duration requestTimeout;
    private final Duration retryDelay;
    private final Duration maxRetryDelay;
    private final HttpLogDetailLevel logLevel;

    public BlobStorageConfiguration(
            String endpoint,
            int maxRetries,
            Duration requestTimeout,
            Duration retryDelay,
            Duration maxRetryDelay,
            HttpLogDetailLevel logLevel) {
        this.endpoint = endpoint;
        this.managedIdentityCredential =
                new ManagedIdentityCredentialBuilder().build();
        this.maxRetries = maxRetries;
        this.requestTimeout = requestTimeout;
        this.retryDelay = retryDelay;
        this.maxRetryDelay = maxRetryDelay;
        this.logLevel = logLevel;
    }

    public BlobServiceClient createSyncClient() {
        return createBuilder().buildClient();
    }

    public BlobServiceAsyncClient createAsyncClient() {
        return createBuilder().buildAsyncClient();
    }

    private BlobServiceClientBuilder createBuilder() {
        RequestRetryOptions retryOptions = new RequestRetryOptions(
                RetryPolicyType.EXPONENTIAL,
                maxRetries,
                requestTimeout,
                retryDelay,
                maxRetryDelay,
                null);
        HttpLogOptions logOptions = new HttpLogOptions().setLogLevel(logLevel);

        return new BlobServiceClientBuilder()
                .endpoint(endpoint)
                .credential(managedIdentityCredential)
                .retryOptions(retryOptions)
                .httpLogOptions(logOptions);
    }
}
