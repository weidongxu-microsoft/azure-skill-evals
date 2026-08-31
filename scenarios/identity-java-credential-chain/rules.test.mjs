import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateJavaCheck,
  loadJavaWorkspace,
} from "../../languages/java/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/credential-chain-java-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadJavaWorkspace(goldenPath);
const sharedChecks = [
  "language/build-manifest",
  "language/current-azure-dependencies",
  "language/current-imports",
];

function workspace(source, build = completeWorkspace.build) {
  return {
    source,
    build,
    sourceFiles: source.trim() ? ["App.java"] : [],
  };
}

test("Java credential-chain golden passes prompt and shared checks", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
  for (const check of sharedChecks) {
    assert.equal(evaluateJavaCheck(check, completeWorkspace), true, check);
  }
});

test("all prompt rules reject a missing application", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
  }
});

test("identity dependency must be active and versioned", () => {
  assert.equal(
    evaluateRule(
      "prompt/identity-package",
      workspace("class App {}", "<!-- com.azure:azure-identity:1.18.5 -->"),
    ),
    false,
  );
});

test("comments, strings, and unreachable blocks cannot fake behavior", () => {
  const fake = workspace(`
class App {
  String sample = "new ChainedTokenCredentialBuilder().addLast(new AzureCliCredentialBuilder().build()).build()";
  void ignored() {
    // credential.getToken(requestContext()).block();
    if (false) {
      new TokenRequestContext().addScopes(SCOPE).setCaeEnabled(true);
    }
  }
}
`);
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-package",
  )) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});

test("dispatcher paths must connect each environment to its chain", () => {
  const disconnected = completeWorkspace.source.replace(
    "case PRODUCTION -> createProductionCredential();",
    "case PRODUCTION -> createDevelopmentCredential();",
  );
  assert.equal(
    evaluateRule("prompt/production-credential-chain", workspace(disconnected)),
    false,
  );
});

test("production requires managed identity first and workload identity second", () => {
  const wrongOrder = completeWorkspace.source.replace(
    /\.addLast\(createManagedIdentityCredential\(\)\)\s*\.addLast\(new WorkloadIdentityCredentialBuilder\(\)\.build\(\)\)/,
    ".addLast(new WorkloadIdentityCredentialBuilder().build())\n"
      + "                .addLast(createManagedIdentityCredential())",
  );
  assert.equal(
    evaluateRule("prompt/production-credential-chain", workspace(wrongOrder)),
    false,
  );

  const hardCoded = completeWorkspace.source.replace(
    'System.getenv("AZURE_CLIENT_ID")',
    '"hard-coded-client-id"',
  );
  assert.equal(
    evaluateRule("prompt/production-credential-chain", workspace(hardCoded)),
    false,
  );
});

test("CI rejects DefaultAzureCredential on the connected path", () => {
  const invalid = completeWorkspace.source.replace(
    "new EnvironmentCredentialBuilder().build()",
    "new DefaultAzureCredentialBuilder().build()",
  );
  assert.equal(
    evaluateRule("prompt/ci-credential-chain", workspace(invalid)),
    false,
  );
});

test("token tests require scope, CAE, expiry, sync blocking, and reactive async", () => {
  for (const invalid of [
    completeWorkspace.source.replace(
      "https://management.azure.com/.default",
      "https://vault.azure.net/.default",
    ),
    completeWorkspace.source.replace(
      ".setCaeEnabled(true)",
      ".setCaeEnabled(false)",
    ),
    completeWorkspace.source.replaceAll("token.getExpiresAt()", "token.getToken()"),
    completeWorkspace.source.replace(
      "credential.getToken(requestContext()).block()",
      "credential.getToken(requestContext())",
    ),
    completeWorkspace.source.replace(
      "return credential.getToken(requestContext())",
      "return Mono.just(true)",
    ),
  ]) {
    assert.equal(evaluateRule("prompt/cae-token-tests", workspace(invalid)), false);
  }
});

test("authentication failures must expose the connected exception detail", () => {
  const genericSync = completeWorkspace.source.replace(
    '"Sync authentication failed: " + exception.getMessage()',
    '"Authentication failed"',
  );
  assert.equal(
    evaluateRule("prompt/auth-failure-details", workspace(genericSync)),
    false,
  );

  const genericAsync = completeWorkspace.source.replace(
    /"Async authentication failed: "\s*\+\s*error\.getMessage\(\)/,
    '"Authentication failed"',
  );
  assert.equal(
    evaluateRule("prompt/auth-failure-details", workspace(genericAsync)),
    false,
  );
});

test("main flow rejects disconnected credentials and unawaited async work", () => {
  const disconnected = completeWorkspace.source.replace(
    "ConnectivityTester.testSync(credential)",
    "ConnectivityTester.testSync(otherCredential)",
  );
  assert.equal(
    evaluateRule("prompt/application-flow", workspace(disconnected)),
    false,
  );

  const unawaited = completeWorkspace.source.replace(
    "ConnectivityTester.testAsync(credential).block()",
    "ConnectivityTester.testAsync(credential)",
  );
  assert.equal(
    evaluateRule("prompt/application-flow", workspace(unawaited)),
    false,
  );
});

test("builder variables and if-dispatched helper methods are accepted", () => {
  const alternate = workspace(`
import com.azure.core.credential.AccessToken;
import com.azure.core.credential.TokenCredential;
import com.azure.core.credential.TokenRequestContext;
import com.azure.core.exception.ClientAuthenticationException;
import com.azure.identity.*;
import reactor.core.publisher.Mono;

enum Environment { DEV, CI, PRODUCTION }

class App {
  static Environment detect() {
    if (System.getenv("TF_BUILD") != null) return Environment.CI;
    if (System.getenv("MSI_ENDPOINT") != null) return Environment.PRODUCTION;
    return Environment.DEV;
  }

  static TokenCredential build(Environment environment) {
    if (environment == Environment.DEV) {
      return dev();
    }
    if (environment == Environment.CI) {
      return ci();
    }
    if (environment == Environment.PRODUCTION) {
      return production();
    }
    throw new IllegalArgumentException();
  }

  static TokenCredential dev() {
    ChainedTokenCredentialBuilder builder = new ChainedTokenCredentialBuilder();
    builder.addLast(new AzureCliCredentialBuilder().build());
    return builder.build();
  }

  static TokenCredential ci() {
    ChainedTokenCredentialBuilder builder = new ChainedTokenCredentialBuilder();
    builder.addLast(new EnvironmentCredentialBuilder().build());
    return builder.build();
  }

  static TokenCredential production() {
    ChainedTokenCredentialBuilder builder = new ChainedTokenCredentialBuilder();
    builder.addLast(managed());
    builder.addLast(new WorkloadIdentityCredentialBuilder().build());
    return builder.build();
  }

  static TokenCredential managed() {
    String clientId = System.getenv("AZURE_CLIENT_ID");
    ManagedIdentityCredentialBuilder builder =
        new ManagedIdentityCredentialBuilder();
    if (clientId != null) builder.clientId(clientId);
    return builder.build();
  }

  static TokenRequestContext request() {
    return new TokenRequestContext()
        .addScopes("https://management.azure.com/.default")
        .setCaeEnabled(true);
  }

  static boolean sync(TokenCredential credential) {
    try {
      AccessToken token = credential.getToken(request()).block();
      System.out.println(token.getExpiresAt());
      return true;
    } catch (ClientAuthenticationException failure) {
      System.err.println(failure.getMessage());
      return false;
    }
  }

  static Mono<Boolean> async(TokenCredential credential) {
    return credential.getToken(request())
        .doOnNext(token -> System.out.println(token.getExpiresAt()))
        .map(token -> true)
        .doOnError(ClientAuthenticationException.class,
            failure -> System.err.println(failure.getMessage()));
  }

  static void main(String[] args) {
    Environment environment = detect();
    System.out.println("environment " + environment);
    System.out.println("strategy selected");
    TokenCredential credential = build(environment);
    sync(credential);
    async(credential).block();
  }
}
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});
