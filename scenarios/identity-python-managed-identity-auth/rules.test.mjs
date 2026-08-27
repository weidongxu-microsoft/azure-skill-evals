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
} from "./tools/managed-identity-python-rules.mjs";

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
    pythonFiles: python.trim() ? ["generated.py"] : [],
  };
}

test("managed identity Python reference passes every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, completeWorkspace), true, rule);
  }
});

test("managed identity Python reference passes applicable shared checks", () => {
  for (const check of applicablePythonChecks) {
    assert.equal(evaluatePythonCheck(check, completeWorkspace), true, check);
  }
});

test("missing generated source fails every prompt rule", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, workspace("")), false, rule);
    assert.equal(
      evaluateRule(rule, workspace("# comment only\n'''documentation'''")),
      false,
      rule,
    );
  }
});

test("only real dependency declarations satisfy the package rule", () => {
  const source = "print('generated')";
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace(source, "azure-identity==1.25.3"),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace(source, "azure-keyvault-secrets==4.11.2"),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace(
        source,
        "# azure-identity\nsummary = 'azure-keyvault-secrets'",
      ),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/identity-packages",
      workspace(
        source,
        '"azure-identity>=1.25",\n"azure-keyvault-secrets>=4.11",',
      ),
    ),
    true,
  );
});

test("qualified aliases and bound credentials are accepted", () => {
  const alternate = workspace(`
import os as environment
import azure.identity as identity
import azure.keyvault.secrets as key_vault

client_id = environment.getenv("AZURE_CLIENT_ID")
vault_url = environment.getenv("AZURE_KEY_VAULT_URL")
secret_name = environment.getenv("AZURE_KEY_VAULT_SECRET_NAME")
system = identity.ManagedIdentityCredential()
user = identity.ManagedIdentityCredential(client_id=client_id)
default = identity.DefaultAzureCredential(
    managed_identity_client_id=client_id,
    exclude_managed_identity_credential=False,
)
cli = identity.AzureCliCredential()
local = identity.ChainedTokenCredential(user, cli)

try:
    with key_vault.SecretClient(vault_url, local) as client:
        print(client.get_secret(secret_name).value)
except identity.CredentialUnavailableError as error:
    raise RuntimeError("Managed identity unavailable") from error
`);

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("aliased async and inline forms are accepted", () => {
  const alternate = workspace(`
from os import environ as env
from azure.identity import AzureCliCredential as CLI
from azure.identity import ChainedTokenCredential as Chain
from azure.identity import CredentialUnavailableError as Unavailable
from azure.identity import DefaultAzureCredential as Default
from azure.identity import ManagedIdentityCredential as Managed
from azure.keyvault.secrets.aio import SecretClient as AsyncSecretClient

client_id = env["AZURE_CLIENT_ID"]
vault_url = env["AZURE_KEY_VAULT_URL"]
secret_name = env["AZURE_KEY_VAULT_SECRET_NAME"]
system = Managed()
user = Managed(client_id=client_id)
configured = Default(managed_identity_client_id=client_id)
fallback = Chain(user, CLI())

try:
    async with AsyncSecretClient(vault_url, fallback) as client:
        secret = await client.get_secret(secret_name)
        print(f"Secret: {secret.value}")
except Unavailable as error:
    print(error)
`);

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("system and user assigned examples must be distinct and valid", () => {
  const onlyUser = workspace(`
import os
from azure.identity import ManagedIdentityCredential
client_id = os.environ["AZURE_CLIENT_ID"]
credential = ManagedIdentityCredential(client_id=client_id)
`);
  assert.equal(
    evaluateRule("prompt/system-assigned-credential", onlyUser),
    false,
  );
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", onlyUser),
    true,
  );

  const wrongClientId = workspace(`
import os
from azure.identity import ManagedIdentityCredential
system = ManagedIdentityCredential()
client_id = os.environ["OTHER_CLIENT_ID"]
user = ManagedIdentityCredential(client_id=client_id)
`);
  assert.equal(
    evaluateRule("prompt/system-assigned-credential", wrongClientId),
    true,
  );
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", wrongClientId),
    false,
  );
});

test("overwritten client ID bindings are rejected", () => {
  const overwritten = workspace(`
import os
from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
client_id = os.environ["AZURE_CLIENT_ID"]
client_id = "hard-coded"
user = ManagedIdentityCredential(client_id=client_id)
default = DefaultAzureCredential(managed_identity_client_id=client_id)
`);
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", overwritten),
    false,
  );
  assert.equal(
    evaluateRule("prompt/default-azure-credential", overwritten),
    false,
  );

  const unbound = workspace(`
from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
user = ManagedIdentityCredential(client_id=client_id)
default = DefaultAzureCredential(managed_identity_client_id=client_id)
`);
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", unbound),
    false,
  );
  assert.equal(
    evaluateRule("prompt/default-azure-credential", unbound),
    false,
  );

  const namedEnvironmentVariable = workspace(`
import os
from azure.identity import ManagedIdentityCredential
CLIENT_ID_ENVIRONMENT_VARIABLE = "AZURE_CLIENT_ID"
client_id = os.environ[CLIENT_ID_ENVIRONMENT_VARIABLE]
user = ManagedIdentityCredential(client_id=client_id)
`);
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", namedEnvironmentVariable),
    true,
  );
});

test("environment provenance rejects every fallback substitution", () => {
  const getenvDefault = workspace(`
from os import getenv
from azure.identity import DefaultAzureCredential, ManagedIdentityCredential
client_id = getenv("AZURE_CLIENT_ID", "literal-client-id")
user = ManagedIdentityCredential(client_id=client_id)
default = DefaultAzureCredential(managed_identity_client_id=client_id)
`);
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", getenvDefault),
    false,
  );
  assert.equal(
    evaluateRule("prompt/default-azure-credential", getenvDefault),
    false,
  );

  const booleanFallback = workspace(`
import os
from azure.identity import ManagedIdentityCredential
client_id = os.environ.get("AZURE_CLIENT_ID") or "literal-client-id"
user = ManagedIdentityCredential(client_id=client_id)
`);
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", booleanFallback),
    false,
  );

  const helperReassignment = workspace(`
import os
from azure.identity import ManagedIdentityCredential
client_id = os.getenv("AZURE_CLIENT_ID")
client_id = use_literal_when_missing(client_id)
user = ManagedIdentityCredential(client_id=client_id)
`);
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", helperReassignment),
    false,
  );
});

test("direct and aliased environment reads survive validation-only checks", () => {
  const validated = workspace(`
import os as environment
from os import getenv as read_environment
from azure.identity import CredentialUnavailableError
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient

client_id = read_environment("AZURE_CLIENT_ID")
if client_id is None:
    raise RuntimeError("AZURE_CLIENT_ID is required")
vault_url = environment.environ["AZURE_KEY_VAULT_URL"]
if not vault_url:
    raise RuntimeError("AZURE_KEY_VAULT_URL is required")
secret_name = environment.environ.get("AZURE_KEY_VAULT_SECRET_NAME")
if secret_name == "":
    raise RuntimeError("AZURE_KEY_VAULT_SECRET_NAME is required")

credential = ManagedIdentityCredential(client_id=client_id)
client = SecretClient(vault_url, credential)
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError as error:
    print(f"Managed identity unavailable: {error}")
`);
  assert.equal(
    evaluateRule("prompt/user-assigned-credential", validated),
    true,
  );
  assert.equal(
    evaluateRule("prompt/credential-client-association", validated),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", validated),
    true,
  );
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", validated),
    true,
  );
});

test("DefaultAzureCredential must enable the configured managed identity", () => {
  const excluded = workspace(`
import os
from azure.identity import DefaultAzureCredential
client_id = os.environ["AZURE_CLIENT_ID"]
credential = DefaultAzureCredential(
    managed_identity_client_id=client_id,
    exclude_managed_identity_credential=True,
)
`);
  assert.equal(
    evaluateRule("prompt/default-azure-credential", excluded),
    false,
  );

  const missingIdentity = workspace(`
from azure.identity import DefaultAzureCredential
credential = DefaultAzureCredential()
`);
  assert.equal(
    evaluateRule("prompt/default-azure-credential", missingIdentity),
    false,
  );
});

test("the local chain requires managed identity before Azure CLI", () => {
  const reversed = workspace(`
from azure.identity import AzureCliCredential, ChainedTokenCredential
from azure.identity import ManagedIdentityCredential
managed = ManagedIdentityCredential()
cli = AzureCliCredential()
credential = ChainedTokenCredential(cli, managed)
`);
  assert.equal(evaluateRule("prompt/local-fallback-chain", reversed), false);

  const unrelatedFirst = workspace(`
from azure.identity import AzureCliCredential, ChainedTokenCredential
from azure.identity import ManagedIdentityCredential
managed = ManagedIdentityCredential()
cli = AzureCliCredential()
credential = ChainedTokenCredential(other, cli)
`);
  assert.equal(
    evaluateRule("prompt/local-fallback-chain", unrelatedFirst),
    false,
  );

  const orderedInline = workspace(`
from azure.identity import AzureCliCredential, ChainedTokenCredential
from azure.identity import ManagedIdentityCredential
credential = ChainedTokenCredential(
    ManagedIdentityCredential(),
    AzureCliCredential(),
)
`);
  assert.equal(
    evaluateRule("prompt/local-fallback-chain", orderedInline),
    true,
  );
});

test("the credential passed to SecretClient must be current and related", () => {
  const wrong = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
credential = ManagedIdentityCredential()
client = SecretClient(vault_url, other_credential)
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", wrong),
    false,
  );

  const overwritten = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
credential = ManagedIdentityCredential()
credential = object()
client = SecretClient(vault_url, credential)
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", overwritten),
    false,
  );

  const shadowed = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
credential = ManagedIdentityCredential()

def run(credential):
    return SecretClient(vault_url, credential)
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", shadowed),
    false,
  );
});

test("SecretClient vault URLs must dataflow from the approved environment", () => {
  for (const invalidVault of [
    `vault_url = os.environ["OTHER_URL"]`,
    `vault_url = "https://example.vault.azure.net"`,
    `vault_url = os.environ["AZURE_KEY_VAULT_URL"]
vault_url = os.environ["OTHER_URL"]`,
  ]) {
    const source = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
${invalidVault}
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())
secret = client.get_secret(secret_name)
print(secret.value)
`);
    assert.equal(
      evaluateRule("prompt/credential-client-association", source),
      false,
    );
    assert.equal(
      evaluateRule("prompt/authenticated-operation", source),
      false,
    );
  }

  const shadowed = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]

def build(
    vault_url,
):
    return SecretClient(vault_url, ManagedIdentityCredential())
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", shadowed),
    false,
  );
});

test("get_secret names must dataflow from the approved environment", () => {
  for (const invalidName of [
    `secret_name = os.environ["OTHER_NAME"]`,
    `secret_name = "literal-name"`,
    `secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
secret_name = os.environ["OTHER_NAME"]`,
  ]) {
    const source = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
${invalidName}
client = SecretClient(vault_url, ManagedIdentityCredential())
secret = client.get_secret(secret_name)
print(secret.value)
`);
    assert.equal(
      evaluateRule("prompt/credential-client-association", source),
      true,
    );
    assert.equal(
      evaluateRule("prompt/authenticated-operation", source),
      false,
    );
  }

  const shadowed = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())

def retrieve(
    secret_name,
):
    secret = client.get_secret(secret_name)
    print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", shadowed),
    false,
  );
});

test("retrieval and value output must use the authenticated client", () => {
  const disconnected = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
credential = ManagedIdentityCredential()
client = SecretClient(vault_url, credential)
secret = other_client.get_secret(secret_name)
print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", disconnected),
    false,
  );

  const missingValue = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())
secret = client.get_secret(secret_name)
print(secret)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", missingValue),
    false,
  );

  const overwrittenResult = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())
secret = client.get_secret(secret_name)
secret = unrelated()
print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", overwrittenResult),
    false,
  );

  const overwrittenClient = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())
client = other_client
secret = client.get_secret(secret_name)
print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", overwrittenClient),
    false,
  );

  const shadowedClient = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())

def retrieve(client):
    secret = client.get_secret(secret_name)
    print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", shadowedClient),
    false,
  );

  const inline = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
print(
    SecretClient(vault_url, ManagedIdentityCredential())
    .get_secret(secret_name)
    .value
)
`);
  assert.equal(evaluateRule("prompt/authenticated-operation", inline), true);

  const extractedValue = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())
secret = client.get_secret(secret_name)
value = secret.value
print(value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", extractedValue),
    true,
  );
});

test("context-manager aliases respect lexical shadowing", () => {
  const aliased = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]

with (
    SecretClient(vault_url, ManagedIdentityCredential()) as managed_client,
):
    client_alias = managed_client
    secret = client_alias.get_secret(secret_name)
    print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", aliased),
    true,
  );
  assert.equal(evaluateRule("prompt/authenticated-operation", aliased), true);

  const shadowedClient = workspace(`
import os
from contextlib import nullcontext
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())

with nullcontext(object()) as client:
    secret = client.get_secret(secret_name)
    print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", shadowedClient),
    false,
  );

  const reassignedAlias = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]

with SecretClient(vault_url, ManagedIdentityCredential()) as client:
    client = object()
    secret = client.get_secret(secret_name)
    print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", reassignedAlias),
    false,
  );

  const shadowedCredential = workspace(`
import os
from contextlib import nullcontext
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
credential = ManagedIdentityCredential()

with nullcontext(object()) as credential:
    client = SecretClient(vault_url, credential)
`);
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      shadowedCredential,
    ),
    false,
  );
});

test("instance-member clients and context aliases are accepted", () => {
  const assignedMemberClient = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient

class VaultReader:
    def __init__(self):
        self.vault_url = os.environ["AZURE_KEY_VAULT_URL"]
        self.secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
        self.client = SecretClient(
            self.vault_url,
            ManagedIdentityCredential(),
        )

    def print_secret(self):
        active_client = self.client
        secret = active_client.get_secret(self.secret_name)
        print(secret.value)
`);
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      assignedMemberClient,
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/authenticated-operation",
      assignedMemberClient,
    ),
    true,
  );

  const memberClient = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient

class VaultReader:
    def __init__(self):
        self.vault_url = os.environ["AZURE_KEY_VAULT_URL"]
        self.secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
        self.credential = ManagedIdentityCredential()

    def print_secret(self):
        with SecretClient(
            self.vault_url,
            self.credential,
        ) as self.client:
            active_client = self.client
            requested_name = self.secret_name
            secret = active_client.get_secret(requested_name)
            print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", memberClient),
    true,
  );
  assert.equal(
    evaluateRule("prompt/authenticated-operation", memberClient),
    true,
  );

  const overwrittenMember = workspace(`
import os
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient

class VaultReader:
    def __init__(self):
        self.vault_url = os.environ["AZURE_KEY_VAULT_URL"]
        self.secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
        self.client = SecretClient(
            self.vault_url,
            ManagedIdentityCredential(),
        )
        self.client = object()

    def print_secret(self):
        active_client = self.client
        secret = active_client.get_secret(self.secret_name)
        print(secret.value)
`);
  assert.equal(
    evaluateRule("prompt/authenticated-operation", overwrittenMember),
    false,
  );
});

test("context-managed credential bindings are accepted", () => {
  const bound = workspace(`
import os
from azure.identity import CredentialUnavailableError
from azure.identity import ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient

vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
try:
    with ManagedIdentityCredential() as credential:
        with SecretClient(vault_url, credential) as client:
            secret = client.get_secret(secret_name)
            print(secret.value)
except CredentialUnavailableError as error:
    print(error)
`);
  assert.equal(
    evaluateRule("prompt/credential-client-association", bound),
    true,
  );
  assert.equal(evaluateRule("prompt/authenticated-operation", bound), true);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", bound),
    true,
  );
});

test("CredentialUnavailableError handling must be useful and connected", () => {
  const base = `
import os
from azure.identity import CredentialUnavailableError, ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())
`;
  const swallowed = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError:
    pass
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", swallowed),
    false,
  );

  const broad = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError as error:
    print(error)
except Exception:
    return
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", broad),
    false,
  );

  const combined = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except (CredentialUnavailableError, RuntimeError) as error:
    print(error)
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", combined),
    false,
  );

  const swallowedUnrelated = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError as error:
    print(error)
except RuntimeError:
    pass
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", swallowedUnrelated),
    false,
  );

  const disconnected = workspace(`${base}
secret = client.get_secret(secret_name)
print(secret.value)
try:
    unrelated()
except CredentialUnavailableError as error:
    print(error)
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", disconnected),
    false,
  );

  for (const ineffectiveHandler of [
    `except CredentialUnavailableError as error:
    print("Managed identity unavailable")`,
    `except CredentialUnavailableError as error:
    print(f"Managed identity unavailable", "{error}")`,
    `except CredentialUnavailableError as error:
    raise RuntimeError("Managed identity unavailable")`,
    `except CredentialUnavailableError as error:
    return`,
  ]) {
    const ineffective = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
${ineffectiveHandler}
`);
    assert.equal(
      evaluateRule("prompt/credential-unavailable-error", ineffective),
      false,
    );
  }

  const separateSwallow = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError as error:
    print(error)
except RuntimeError as error:
    print("Runtime failure")
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", separateSwallow),
    false,
  );

  const multilineSeparateSwallow = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError as error:
    print(error)
except (
    RuntimeError,
) as error:
    print("Runtime failure")
`);
  assert.equal(
    evaluateRule(
      "prompt/credential-unavailable-error",
      multilineSeparateSwallow,
    ),
    false,
  );

  const nestedSwallow = workspace(`${base}
try:
    try:
        secret = client.get_secret(secret_name)
        print(secret.value)
    except CredentialUnavailableError as error:
        print(error)
except RuntimeError:
    pass
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", nestedSwallow),
    false,
  );

  const useful = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError as error:
    raise RuntimeError("Managed identity unavailable") from error
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", useful),
    true,
  );

  const usefulWithRethrowingSibling = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError as error:
    logger.error("Managed identity unavailable: %s", error)
except RuntimeError:
    raise
`);
  assert.equal(
    evaluateRule(
      "prompt/credential-unavailable-error",
      usefulWithRethrowingSibling,
    ),
    true,
  );

  const bareRethrow = workspace(`${base}
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError:
    raise
`);
  assert.equal(
    evaluateRule("prompt/credential-unavailable-error", bareRethrow),
    true,
  );
});

test("every reachable Python except path must causally preserve failures", () => {
  const safeBase = `
import os
from azure.identity import CredentialUnavailableError, ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except CredentialUnavailableError as unavailable:
    print(unavailable)
`;
  const unsafeHandlers = [
    `try:
    unrelated()
except RuntimeError as failure:
    logger.error(failure)`,
    `try:
    unrelated()
except RuntimeError as failure:
    if should_propagate:
        raise failure`,
    `try:
    unrelated()
except RuntimeError as failure:
    raise RuntimeError("replacement")`,
    `try:
    unrelated()
except RuntimeError as failure:
    return`,
    `try:
    unrelated()
except RuntimeError as failure:
    try:
        recover()
    except ValueError as nested:
        logger.error(nested)
    raise failure`,
  ];
  for (const handler of unsafeHandlers) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${safeBase}\n${handler}`),
      ),
      false,
      handler,
    );
  }

  const safeHandlers = [
    `try:
    unrelated()
except RuntimeError:
    raise`,
    `try:
    unrelated()
except RuntimeError as failure:
    if should_wrap:
        raise RuntimeError("wrapped") from failure
    else:
        raise failure`,
  ];
  for (const handler of safeHandlers) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${safeBase}\n${handler}`),
      ),
      true,
      handler,
    );
  }
});

test("Python loop paths cannot hide unsafe catch terminals", () => {
  const prefix = `
import os
from azure.identity import CredentialUnavailableError, ManagedIdentityCredential
from azure.keyvault.secrets import SecretClient
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
client = SecretClient(vault_url, ManagedIdentityCredential())
try:
    print(client.get_secret(secret_name).value)
except CredentialUnavailableError as unavailable:
    print(unavailable)
try:
    unrelated()
`;
  const unsafe = [
    `except RuntimeError as failure:
    while should_retry: return
    raise failure`,
    `except RuntimeError as failure:
    for item in items:
        if should_return(item):
            return
    raise failure`,
    `except RuntimeError as failure:
    for item in items:
        if is_bad(item):
            raise RuntimeError("replacement")
    raise failure`,
    `except RuntimeError as failure:
    while should_retry:
        if should_return:
            return
        break
    raise failure`,
    `except RuntimeError as failure:
    while True:
        continue`,
    `except RuntimeError as failure:
    for item in items:
        break
    else:
        raise RuntimeError("replacement")
    raise failure`,
  ];
  for (const handler of unsafe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${prefix}${handler}`),
      ),
      false,
      handler,
    );
  }

  const safe = [
    `except RuntimeError as failure:
    while should_retry:
        break
    raise failure`,
    `except RuntimeError as failure:
    for item in items:
        if should_stop(item):
            raise failure
    raise failure`,
    `except RuntimeError as failure:
    while should_retry:
        break
        return
    raise failure`,
    `except RuntimeError as failure:
    while should_retry:
        continue
        raise RuntimeError("replacement")
    raise failure`,
    `except RuntimeError as failure:
    while False:
        return
    raise failure`,
  ];
  for (const handler of safe) {
    assert.equal(
      evaluateRule(
        "prompt/credential-unavailable-error",
        workspace(`${prefix}${handler}`),
      ),
      true,
      handler,
    );
  }
});

test("comments, strings, filenames, and prose cannot provide behavior", () => {
  const fake = workspace(`
# ManagedIdentityCredential()
documentation = """
ManagedIdentityCredential()
DefaultAzureCredential(managed_identity_client_id=client_id)
ChainedTokenCredential(ManagedIdentityCredential(), AzureCliCredential())
SecretClient(vault_url, credential).get_secret(secret_name).value
except CredentialUnavailableError:
    print(error)
"""
print("identity-python-managed-identity-auth")
`);
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-packages",
  )) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }
});
