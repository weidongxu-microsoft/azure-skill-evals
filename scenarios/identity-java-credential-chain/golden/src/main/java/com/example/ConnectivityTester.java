package com.example;

import com.azure.core.credential.AccessToken;
import com.azure.core.credential.TokenCredential;
import com.azure.core.exception.ClientAuthenticationException;
import com.azure.core.credential.TokenRequestContext;
import reactor.core.publisher.Mono;

public final class ConnectivityTester {
    private static final String ARM_SCOPE =
            "https://management.azure.com/.default";

    private ConnectivityTester() {
    }

    private static TokenRequestContext requestContext() {
        return new TokenRequestContext()
                .addScopes(ARM_SCOPE)
                .setCaeEnabled(true);
    }

    public static boolean testSync(TokenCredential credential) {
        try {
            AccessToken token = credential.getToken(requestContext()).block();
            if (token == null) {
                throw new ClientAuthenticationException(
                        "The credential returned no token.", null);
            }
            System.out.println("Sync token expires at " + token.getExpiresAt());
            return true;
        } catch (ClientAuthenticationException exception) {
            System.err.println(
                    "Sync authentication failed: " + exception.getMessage());
            return false;
        }
    }

    public static Mono<Boolean> testAsync(TokenCredential credential) {
        return credential.getToken(requestContext())
                .doOnNext(token -> System.out.println(
                        "Async token expires at " + token.getExpiresAt()))
                .map(token -> true)
                .doOnError(
                        ClientAuthenticationException.class,
                        error -> System.err.println(
                                "Async authentication failed: "
                                        + error.getMessage()));
    }
}
