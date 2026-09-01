import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/identity-python-rules.mjs";

const goldenWorkspacePath = fileURLToPath(new URL("./golden", import.meta.url));
const completeWorkspace = loadPythonWorkspace(goldenWorkspacePath);
const applicablePythonChecks = [
  "language/correct-imports",
  "language/default-azure-credential",
  "language/client-lifecycle",
  "language/exception-handling",
];

function workspace(python, dependencies = completeWorkspace.dependencies) {
  return {
    dependencies,
    python,
    pythonFiles: python.trim() ? ["app.py"] : [],
  };
}

test.skip("identity Python reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test.skip("identity Python reference passes applicable shared checks", () => {
  for (const check of applicablePythonChecks) {
    assert.equal(evaluatePythonCheck(check, completeWorkspace), true, check);
  }
});

test.skip("missing generated source fails every prompt rule", () => {
  const missingSource = workspace("");
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, missingSource), false, rule);
  }
});

test.skip("both pinned package families are required", () => {
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace("print('generated')", "azure-identity==1.25.3"),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace("print('generated')", "azure-keyvault-secrets==4.11.2"),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace(
        "print('generated')",
        "# azure-identity\n# azure-keyvault-secrets",
      ),
    ),
    false,
  );
});

test.skip("qualified imports, inline credentials, and valid options are accepted", () => {
  const alternate = workspace(`
import azure.core.exceptions
import azure.identity as identity
import azure.keyvault.secrets as secrets
import logging

logging.basicConfig(level=logging.DEBUG)
logging.getLogger("azure.identity").setLevel(logging.DEBUG)

try:
    with secrets.SecretClient(
        vault_url,
        identity.DefaultAzureCredential(exclude_cli_credential=True),
    ) as client:
        print(client.get_secret(secret_name).value)
except azure.core.exceptions.ClientAuthenticationError as error:
    logging.error("Authentication failed: %s", error)
except azure.core.exceptions.HttpResponseError as error:
    logging.error("Key Vault request failed: %s", error)
`);

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test.skip("aliased async clients, credentials, and request errors are accepted", () => {
  const alternate = workspace(`
from azure.core.exceptions import ClientAuthenticationError as AuthError, ServiceRequestError as RequestError
from azure.identity import DefaultAzureCredential as Credential
from azure.keyvault.secrets.aio import SecretClient as AsyncSecretClient
from logging import DEBUG, StreamHandler, getLogger

identity_logger = getLogger("azure.identity")
identity_logger.setLevel(DEBUG)
identity_logger.addHandler(StreamHandler())

credential = Credential(require_envvar=True)
try:
    async with AsyncSecretClient(vault_url, credential) as client:
        secret = await client.get_secret(secret_name)
        print(secret.value)
except (AuthError, RuntimeError) as error:
    raise RuntimeError("Authentication failed") from error
except RequestError as error:
    raise RuntimeError("Key Vault request failed") from error
`);

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test.skip("comments and strings cannot provide source behavior", () => {
  const fake = workspace(`
# credential = DefaultAzureCredential()
example = """
from azure.identity import DefaultAzureCredential
client = SecretClient(vault_url, DefaultAzureCredential())
client.get_secret("name")
except ClientAuthenticationError:
    raise
logging.getLogger("azure.identity").setLevel(logging.DEBUG)
"""
`);

  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-packages",
  )) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});

test.skip("an unused credential does not satisfy client association", () => {
  const unused = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

credential = DefaultAzureCredential()
client = SecretClient(vault_url, other_credential)
`);

  assert.equal(evaluateRule("prompt/default-azure-credential", unused), true);
  assert.equal(
    evaluateRule("prompt/credential-client-association", unused),
    false,
  );
});

test.skip("a credential passed to the wrong client is rejected", () => {
  const wrongClient = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
from azure.storage.blob import BlobServiceClient

credential = DefaultAzureCredential()
blob = BlobServiceClient(account_url, credential)
secrets = SecretClient(vault_url, other_credential)
secrets.get_secret(secret_name)
`);

  assert.equal(
    evaluateRule("prompt/credential-client-association", wrongClient),
    false,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", wrongClient),
    false,
  );
});

test.skip("an operation on a disconnected client is rejected", () => {
  const disconnected = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

credential = DefaultAzureCredential()
client = SecretClient(vault_url, credential)
other_client.get_secret(secret_name)
`);

  assert.equal(
    evaluateRule("prompt/credential-client-association", disconnected),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", disconnected),
    false,
  );
});

test.skip("non-retrieval operations and missing value output are rejected", () => {
  const nonRetrieval = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
secret = client.set_secret(secret_name, secret_value)
print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", nonRetrieval),
    false,
  );

  const missingOutput = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
secret = client.get_secret(secret_name)
print(secret)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", missingOutput),
    false,
  );

  const disconnectedOutput = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
secret = client.get_secret(secret_name)
print(container.secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", disconnectedOutput),
    false,
  );

  const reassignedOutput = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
secret = client.get_secret(secret_name)
secret = unrelated_result()
print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", reassignedOutput),
    false,
  );

  const literalOutput = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
secret = client.get_secret(secret_name)
print("{secret.value}")
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", literalOutput),
    false,
  );
});

test.skip("chained operations on an inline authenticated client are accepted", () => {
  const chained = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

print(
    SecretClient(
        vault_url,
        DefaultAzureCredential(),
    ).get_secret(secret_name).value
)
`);

  assert.equal(
    evaluateRule("prompt/credential-client-association", chained),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", chained),
    true,
  );
});

test.skip("wrong or swallowed authentication exceptions are rejected", () => {
  const wrongError = workspace(`
from azure.core.exceptions import ClientAuthenticationError

try:
    authenticate()
except RuntimeError as error:
    print(error)
`);
  assert.equal(evaluateRule("prompt/auth-errors", wrongError), false);

  const swallowed = workspace(`
from azure.core.exceptions import ClientAuthenticationError

try:
    authenticate()
except ClientAuthenticationError:
    pass
`);
  assert.equal(evaluateRule("prompt/auth-errors", swallowed), false);
});

test.skip("error handlers must be separate and connected to retrieval", () => {
  const disconnected = workspace(`
from azure.core.exceptions import ClientAuthenticationError, HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
secret = client.get_secret(secret_name)
print(secret.value)

try:
    unrelated_operation()
except ClientAuthenticationError as error:
    print(error)
except HttpResponseError as error:
    print(error)
`);
  assert.equal(evaluateRule("prompt/auth-errors", disconnected), false);

  const combined = workspace(`
from azure.core.exceptions import ClientAuthenticationError, HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except (ClientAuthenticationError, HttpResponseError) as error:
    print(error)
`);
  assert.equal(evaluateRule("prompt/auth-errors", combined), false);

  const missingServiceHandler = workspace(`
from azure.core.exceptions import ClientAuthenticationError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except ClientAuthenticationError as error:
    print(error)
`);
  assert.equal(
    evaluateRule("prompt/auth-errors", missingServiceHandler),
    false,
  );

  const swallowedConnectedHandler = workspace(`
from azure.core.exceptions import ClientAuthenticationError, HttpResponseError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except ClientAuthenticationError:
    pass
except HttpResponseError as error:
    print(error)
`);
  assert.equal(
    evaluateRule("prompt/auth-errors", swallowedConnectedHandler),
    false,
  );
});

test.skip("separate connected authentication and response handlers are accepted", () => {
  const connected = workspace(`
from azure.core import exceptions as azure_errors
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
try:
    value = client.get_secret(secret_name).value
    print(value)
except azure_errors.ClientAuthenticationError:
    raise
except azure_errors.ServiceResponseError:
    return
`);

  assert.equal(evaluateRule("prompt/authenticated-operation", connected), true);
  assert.equal(evaluateRule("prompt/auth-errors", connected), true);
});

test.skip("formatted secret value output is accepted", () => {
  const formatted = workspace(`
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

client = SecretClient(vault_url, DefaultAzureCredential())
secret = client.get_secret(secret_name)
print(f"Secret value: {secret.value}")
`);

  assert.equal(evaluateRule("prompt/authenticated-operation", formatted), true);
});

test.skip("fake diagnostics are rejected", () => {
  const fake = workspace(`
import logging

print("azure.identity DEBUG diagnostics enabled")
logging.getLogger("application").setLevel(logging.DEBUG)
`);

  assert.equal(evaluateRule("prompt/identity-diagnostics", fake), false);
});
