package com.example;

import com.azure.core.credential.AccessToken;
import com.azure.core.credential.TokenCredential;
import com.azure.core.credential.TokenRequestContext;
import com.azure.core.exception.ClientAuthenticationException;
import com.azure.identity.CredentialUnavailableException;
import reactor.core.publisher.Mono;

public final class ConnectivityTester {
    private static final String ARM_SCOPE =
            "https://management.azure.com/.default";

    private ConnectivityTester() {
    }

    private static TokenRequestContext requestContext(boolean caeEnabled) {
        return new TokenRequestContext()
                .addScopes(ARM_SCOPE)
                .setCaeEnabled(caeEnabled);
    }

    public static boolean testSync(
            TokenCredential credential, boolean caeEnabled) {
        System.out.println("Sync CAE requested: " + caeEnabled);
        try {
            AccessToken token =
                    credential.getToken(requestContext(caeEnabled)).block();
            if (token == null) {
                throw new ClientAuthenticationException(
                        "The credential returned no token.", null);
            }
            System.out.println(
                    "Sync authentication succeeded; token expires at "
                            + token.getExpiresAt());
            return true;
        } catch (CredentialUnavailableException exception) {
            reportFailure("Sync", "No configured credential was available", exception);
            return false;
        } catch (ClientAuthenticationException exception) {
            reportFailure("Sync", "Azure rejected the credential", exception);
            return false;
        }
    }

    public static Mono<Boolean> testAsync(
            TokenCredential credential, boolean caeEnabled) {
        System.out.println("Async CAE requested: " + caeEnabled);
        return credential.getToken(requestContext(caeEnabled))
                .map(token -> {
                    System.out.println(
                            "Async authentication succeeded; token expires at "
                                    + token.getExpiresAt());
                    return true;
                })
                .onErrorResume(
                        CredentialUnavailableException.class,
                        error -> {
                            reportFailure(
                                    "Async",
                                    "No configured credential was available",
                                    error);
                            return Mono.just(false);
                        })
                .onErrorResume(
                        ClientAuthenticationException.class,
                        error -> {
                            reportFailure(
                                    "Async",
                                    "Azure rejected the credential",
                                    error);
                            return Mono.just(false);
                        });
    }

    private static void reportFailure(
            String mode, String reason, RuntimeException exception) {
        System.err.printf(
                "%s authentication failed: %s (%s: %s)%n",
                mode,
                reason,
                exception.getClass().getSimpleName(),
                exception.getMessage());
        if (exception.getCause() != null) {
            System.err.printf(
                    "Cause: %s: %s%n",
                    exception.getCause().getClass().getSimpleName(),
                    exception.getCause().getMessage());
        }
    }
}
