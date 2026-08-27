import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadServicePrincipalWorkspace,
  ruleNames,
} from "./tools/service-principal-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const goldenWorkspace = loadServicePrincipalWorkspace(goldenPath);
const dependencies = goldenWorkspace.dependencies;
const sourceRules = ruleNames().filter(
  (name) => name !== "prompt/identity-packages",
);

function workspace(
  python,
  manifest = dependencies,
  filename = "requirements.txt",
) {
  return {
    dependencies: manifest,
    dependencyManifests: [{ content: manifest, filename }],
    sources: [python],
  };
}

const completeSource = `
import os
import sys
from azure.core.exceptions import ClientAuthenticationError
from azure.identity import ClientSecretCredential
from azure.keyvault.secrets import SecretClient

tenant_id = os.environ["AZURE_TENANT_ID"]
client_id = os.environ["AZURE_CLIENT_ID"]
client_secret = os.environ["AZURE_CLIENT_SECRET"]
vault_url = os.environ["AZURE_KEY_VAULT_URL"]
secret_name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
credential = ClientSecretCredential(tenant_id, client_id, client_secret)
client = SecretClient(vault_url, credential)
try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except ClientAuthenticationError as error:
    print(error, file=sys.stderr)
`;

test("real pinned golden passes all six equally weighted rules", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/identity-packages",
    "prompt/environment-secret-management",
    "prompt/client-secret-credential",
    "prompt/credential-client-association",
    "prompt/authenticated-operation",
    "prompt/authentication-errors",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }
});

test("workspace discovery recursively includes only application Python", () => {
  const root = fileURLToPath(new URL("./.recursive-source-fixture", import.meta.url));
  rmSync(root, { force: true, recursive: true });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "build", "generated"), { recursive: true });
    mkdirSync(join(root, ".venv", "Lib", "site-packages"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    writeFileSync(join(root, "src", "main.py"), completeSource);
    writeFileSync(join(root, "tests", "test_decoy.py"), "print(client_secret)");
    writeFileSync(join(root, "build", "generated", "decoy.py"), completeSource);
    writeFileSync(
      join(root, ".venv", "Lib", "site-packages", "decoy.py"),
      completeSource,
    );

    const discovered = loadServicePrincipalWorkspace(root);
    assert.deepEqual(discovered.pythonFiles, [join(root, "src", "main.py")]);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, discovered), true, rule);
    }

    writeFileSync(join(root, "src", "main.py"), "print('application')");
    const decoysOnly = loadServicePrincipalWorkspace(root);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, decoysOnly), false, rule);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("missing, invalid, comment-only, and prose-only source fail", () => {
  for (const source of [
    "",
    "# ClientSecretCredential and SecretClient.get_secret\n",
    '"""AZURE_CLIENT_SECRET ClientAuthenticationError"""\n',
    "this is not valid Python",
  ]) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace(source)), false, rule);
    }
  }
});

test("runtime requirements declarations accept standard forms", () => {
  for (const [filename, manifest] of [
    [
      "requirements.txt",
      "azure-identity==1.25.3\nazure-keyvault-secrets==4.11.2",
    ],
    [
      "requirements-prod.txt",
      "azure_identity[broker]>=1.25\nazure.keyvault.secrets~=4.11",
    ],
    [
      "requirements.runtime.txt",
      "azure-identity @ https://example.invalid/identity.whl\nazure-keyvault-secrets; python_version >= '3.10'",
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("print('generated')", manifest, filename),
      ),
      true,
      filename,
    );
  }
});

test("PEP 621 and Poetry runtime dependencies are accepted", () => {
  for (const manifest of [
    `[project]
dependencies = [
  "azure-identity>=1.25",
  "azure-keyvault-secrets>=4.11",
]`,
    `[tool.poetry.dependencies]
python = "^3.11"
azure-identity = "1.25.3"
azure-keyvault-secrets = { version = "^4.11" }`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("print('generated')", manifest, "pyproject.toml"),
      ),
      true,
      manifest,
    );
  }
});

test("active setup.py runtime dependencies are accepted", () => {
  for (const manifest of [
    `from setuptools import setup
setup(install_requires=[
    "azure-identity>=1.25",
    "azure-keyvault-secrets>=4.11",
])`,
    `import setuptools as packaging
runtime_requirements = [
    "azure_identity[broker]~=1.25",
    "azure.keyvault.secrets==4.11.2",
]
packaging.setup(name="sample", install_requires=runtime_requirements)`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("print('generated')", manifest, "setup.py"),
      ),
      true,
      manifest,
    );
  }
});

test("disconnected and non-runtime setup.py package text is rejected", () => {
  for (const manifest of [
    `from setuptools import setup
requirements = ["azure-identity", "azure-keyvault-secrets"]
setup(name="sample")`,
    `from setuptools import setup
setup(extras_require={
    "dev": ["azure-identity", "azure-keyvault-secrets"],
})`,
    `from setuptools import setup
setup = lambda **kwargs: None
setup(install_requires=["azure-identity", "azure-keyvault-secrets"])`,
    `from setuptools import setup
if False:
    setup(install_requires=["azure-identity", "azure-keyvault-secrets"])`,
    `# setup(install_requires=["azure-identity", "azure-keyvault-secrets"])
description = "Requires azure-identity and azure-keyvault-secrets"`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("print('generated')", manifest, "setup.py"),
      ),
      false,
      manifest,
    );
  }
});

test("non-runtime dependency sections and artifacts do not score", () => {
  for (const manifest of [
    `[tool.poetry.group.dev.dependencies]
azure-identity = "1.25.3"
azure-keyvault-secrets = "4.11.2"`,
    `[tool.poetry.dev-dependencies]
azure-identity = "1.25.3"
azure-keyvault-secrets = "4.11.2"`,
    `[tool.poetry.dependencies]
azure-identity = { version = "1.25.3", optional = true }
azure-keyvault-secrets = { version = "4.11.2", optional = true }`,
    `[project.optional-dependencies]
azure = ["azure-identity", "azure-keyvault-secrets"]`,
    `[dependency-groups]
test = ["azure-identity", "azure-keyvault-secrets"]`,
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("print('generated')", manifest, "pyproject.toml"),
      ),
      false,
      manifest,
    );
  }
  for (const [filename, manifest] of [
    [
      "requirements-dev.txt",
      "azure-identity\nazure-keyvault-secrets",
    ],
    [
      "requirements-test.txt",
      "azure-identity\nazure-keyvault-secrets",
    ],
    [
      "setup.py",
      'azure-identity = "1.25.3"\nazure-keyvault-secrets = "4.11.2"',
    ],
    [
      "requirements.txt",
      "# azure-identity\n# azure-keyvault-secrets",
    ],
    [
      "requirements.txt",
      "Install azure-identity and azure-keyvault-secrets before running.",
    ],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("print('generated')", manifest, filename),
      ),
      false,
      filename,
    );
  }
});

test("both runtime packages are required", () => {
  for (const manifest of [
    "azure-identity==1.25.3",
    "azure-keyvault-secrets==4.11.2",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/identity-packages",
        workspace("print('generated')", manifest),
      ),
      false,
      manifest,
    );
  }
});

test("qualified imports, helper reads, members, and context aliases pass", () => {
  const alternate = workspace(`
import os as environment
import azure.identity as identity
import azure.keyvault.secrets as vault
from azure.core import exceptions as errors

def required_environment(name):
    value = environment.getenv(name)
    if value is None:
        raise RuntimeError(f"{name} is required")
    return value

class VaultReader:
    def __init__(self):
        self.tenant = required_environment("AZURE_TENANT_ID")
        self.application = required_environment("AZURE_CLIENT_ID")
        self.password = required_environment("AZURE_CLIENT_SECRET")
        self.url = required_environment("AZURE_KEY_VAULT_URL")
        self.name = required_environment("AZURE_KEY_VAULT_SECRET_NAME")
        self.credential = identity.ClientSecretCredential(
            tenant_id=self.tenant,
            client_id=self.application,
            client_secret=self.password,
        )
        self.client = vault.SecretClient(self.url, self.credential)

    def show(self):
        try:
            with self.client as active_client:
                found = active_client.get_secret(name=self.name)
                print(f"Secret value: {found.value}")
        except errors.ClientAuthenticationError as failure:
            raise RuntimeError("Azure authentication failed") from failure
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("aliased asynchronous constructors and extracted values pass", () => {
  const alternate = workspace(`
from os import getenv as read_environment
from azure.core.exceptions import ClientAuthenticationError as AuthFailure
from azure.identity import ClientSecretCredential as Credential
from azure.keyvault.secrets.aio import SecretClient as AsyncSecretClient

async def run():
    tenant = read_environment("AZURE_TENANT_ID")
    application = read_environment("AZURE_CLIENT_ID")
    password = read_environment("AZURE_CLIENT_SECRET")
    url = read_environment("AZURE_KEY_VAULT_URL")
    name = read_environment("AZURE_KEY_VAULT_SECRET_NAME")
    try:
        async with Credential(tenant, application, password) as credential:
            async with AsyncSecretClient(
                vault_url=url,
                credential=credential,
            ) as client:
                response = await client.get_secret(name)
                value = response.value
                print(value)
    except AuthFailure as failure:
        logger.exception("Authentication failed: %s", failure)
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("every required environment key must be read exactly", () => {
  for (const key of [
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_SECRET",
    "AZURE_KEY_VAULT_URL",
    "AZURE_KEY_VAULT_SECRET_NAME",
  ]) {
    const source = completeSource.replaceAll(key, `OTHER_${key}`);
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
      key,
    );
  }
});

test("literal, default, and boolean fallbacks lose provenance", () => {
  const cases = [
    completeSource.replace(
      'os.environ["AZURE_TENANT_ID"]',
      'os.getenv("AZURE_TENANT_ID", "tenant")',
    ),
    completeSource.replace(
      'os.environ["AZURE_CLIENT_ID"]',
      'os.environ.get("AZURE_CLIENT_ID", "application")',
    ),
    completeSource.replace(
      'os.environ["AZURE_CLIENT_SECRET"]',
      'os.getenv("AZURE_CLIENT_SECRET") or "password"',
    ),
    completeSource.replace(
      'os.environ["AZURE_KEY_VAULT_URL"]',
      '"https://example.vault.azure.net"',
    ),
    completeSource.replace(
      'os.environ["AZURE_KEY_VAULT_SECRET_NAME"]',
      'os.getenv("AZURE_KEY_VAULT_SECRET_NAME", "name")',
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/environment-secret-management", workspace(source)),
      false,
    );
  }
});

test("the client secret cannot be hard-coded, printed, logged, or leaked", () => {
  const outputs = [
    "print(client_secret)",
    'print(f"client secret: {client_secret}")',
    "print(client_secret.strip())",
    "logger.info(client_secret)",
    "sys.stderr.write(client_secret)",
  ];
  for (const output of outputs) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${completeSource}\n${output}\n`),
      ),
      false,
      output,
    );
  }

  const extraUnsafeCredential = `${completeSource}
unsafe = ClientSecretCredential(tenant_id, client_id, "hard-coded")
`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(extraUnsafeCredential),
    ),
    false,
  );
});

test("client-secret taint crosses 4, 16, and 64 forward helper calls", () => {
  for (const depth of [4, 16, 64]) {
    const helpers = Array.from(
      { length: depth },
      (_, index) => `def helper_${index}(value):
    return helper_${index + 1}(value)`,
    ).join("\n\n");
    const source = `${completeSource}
${helpers}

def helper_${depth}(value):
    return value

logger.error(helper_0(client_secret))
`;
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(source),
      ),
      false,
      `helper depth ${depth}`,
    );
  }
});

test("client-secret taint crosses aliases, fields, collections, and returns", () => {
  const leaks = [
    `alias = client_secret
second_alias = alias
print(second_alias)`,
    `holder = object()
holder.password = client_secret
sys.stderr.write(holder.password)`,
    `values = []
alias = values
alias.append(client_secret)
logger.info(values)`,
    `inner = []
outer = [inner]
inner.extend([client_secret])
print(outer)`,
    `values = {}
values.update({"password": client_secret})
logger.warning(values)`,
    `values = {}
values["password"] = client_secret
print(values["password"])`,
    `def return_secret(value):
    return {"password": value}
print(return_secret(client_secret))`,
    `class Holder:
    def save(self, value):
        self.value = value

    def reveal(self):
        return self.value

holder = Holder()
holder.save(client_secret)
logger.info(holder.reveal())`,
    `class StaticSink:
    @staticmethod
    def emit(value):
        logger.error(value)

StaticSink.emit(client_secret)`,
  ];
  for (const leak of leaks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${completeSource}\n${leak}\n`),
      ),
      false,
      leak,
    );
  }
});

test("formatted output and pseudo-redactors preserve client-secret taint", () => {
  const leaks = [
    'logger.info("password={}".format(client_secret))',
    'sys.stderr.write(f"password={client_secret}")',
    `def identity(value):
    return value
print(identity(client_secret))`,
    `def conditional_redactor(value):
    return "[REDACTED]" if hide_secrets else value
logger.info(conditional_redactor(client_secret))`,
    `def emit(value):
    logger.error("credential: %s", value)
emit(client_secret)`,
  ];
  for (const leak of leaks) {
    assert.equal(
      evaluateRule(
        "prompt/environment-secret-management",
        workspace(`${completeSource}\n${leak}\n`),
      ),
      false,
      leak,
    );
  }
});

test("constant redaction and credential wrappers do not leak secrets", () => {
  const safelyRedacted = `${completeSource}
def redact(_value):
    return "[REDACTED]"

print("credential configured")
logger.info("password=%s", redact(client_secret))
`;
  assert.equal(
    evaluateRule(
      "prompt/environment-secret-management",
      workspace(safelyRedacted),
    ),
    true,
  );

  const wrappedCredential = completeSource.replace(
    "credential = ClientSecretCredential(tenant_id, client_id, client_secret)",
    `class CredentialFactory:
    def build(self, tenant, application, password):
        return ClientSecretCredential(tenant, application, password)

factory = CredentialFactory()
credential = factory.build(tenant_id, client_id, client_secret)`,
  );
  for (const rule of [
    "prompt/environment-secret-management",
    "prompt/client-secret-credential",
    "prompt/credential-client-association",
  ]) {
    assert.equal(evaluateRule(rule, workspace(wrappedCredential)), true, rule);
  }
});

test("ClientSecretCredential requires correct current values", () => {
  const invalidConstructors = [
    "ClientSecretCredential(client_id, tenant_id, client_secret)",
    "ClientSecretCredential(tenant_id, client_id, 'literal')",
    "ClientSecretCredential(tenant_id=tenant_id, client_id=client_id)",
    "ClientSecretCredential(tenant_id, client_id, client_secret, tenant_id=tenant_id)",
    "FakeClientSecretCredential(tenant_id, client_id, client_secret)",
  ];
  for (const constructor of invalidConstructors) {
    const source = completeSource.replace(
      "ClientSecretCredential(tenant_id, client_id, client_secret)",
      constructor,
    );
    assert.equal(
      evaluateRule("prompt/client-secret-credential", workspace(source)),
      false,
      constructor,
    );
  }
});

test("credential inputs honor reassignment and lexical shadowing", () => {
  const reassigned = completeSource.replace(
    "credential = ClientSecretCredential",
    'client_secret = "changed"\ncredential = ClientSecretCredential',
  );
  assert.equal(
    evaluateRule("prompt/client-secret-credential", workspace(reassigned)),
    false,
  );

  const shadowed = `
import os
from azure.identity import ClientSecretCredential
tenant_id = os.environ["AZURE_TENANT_ID"]
client_id = os.environ["AZURE_CLIENT_ID"]
client_secret = os.environ["AZURE_CLIENT_SECRET"]

def build(client_secret):
    return ClientSecretCredential(tenant_id, client_id, client_secret)
`;
  assert.equal(
    evaluateRule("prompt/client-secret-credential", workspace(shadowed)),
    false,
  );
});

test("credential helper return values can reach SecretClient", () => {
  const helper = workspace(`
import os
from azure.core.exceptions import ClientAuthenticationError
from azure.identity import ClientSecretCredential
from azure.keyvault.secrets import SecretClient

def credential_for(tenant, application, password):
    return ClientSecretCredential(tenant, application, password)

tenant = os.environ["AZURE_TENANT_ID"]
application = os.environ["AZURE_CLIENT_ID"]
password = os.environ["AZURE_CLIENT_SECRET"]
url = os.environ["AZURE_KEY_VAULT_URL"]
name = os.environ["AZURE_KEY_VAULT_SECRET_NAME"]
credential = credential_for(tenant, application, password)
try:
    print(SecretClient(url, credential).get_secret(name).value)
except ClientAuthenticationError:
    raise
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, helper), true, rule);
  }
});

test("SecretClient requires the proven credential and vault URL", () => {
  for (const replacement of [
    "SecretClient(vault_url, other_credential)",
    "SecretClient(other_url, credential)",
    "FakeSecretClient(vault_url, credential)",
  ]) {
    const source = completeSource.replace(
      "SecretClient(vault_url, credential)",
      replacement,
    );
    assert.equal(
      evaluateRule(
        "prompt/credential-client-association",
        workspace(source),
      ),
      false,
      replacement,
    );
  }
});

test("reassigned and parameter-shadowed credentials are disconnected", () => {
  const reassigned = completeSource.replace(
    "client = SecretClient",
    "credential = object()\nclient = SecretClient",
  );
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      workspace(reassigned),
    ),
    false,
  );

  const shadowed = completeSource.replace(
    "client = SecretClient(vault_url, credential)",
    `
def build(credential):
    return SecretClient(vault_url, credential)
client = build(object())
`,
  );
  assert.equal(
    evaluateRule(
      "prompt/credential-client-association",
      workspace(shadowed),
    ),
    false,
  );
});

test("authenticated operation, result, value, and output stay connected", () => {
  const invalid = [
    completeSource.replace("client.get_secret", "other_client.get_secret"),
    completeSource.replace("get_secret(secret_name)", "get_secret(other_name)"),
    completeSource.replace("print(secret.value)", "print(secret)"),
    completeSource.replace(
      "print(secret.value)",
      "print(unrelated.value)",
    ),
    completeSource.replace(
      "print(secret.value)",
      "secret = unrelated()\n    print(secret.value)",
    ),
    completeSource.replace(
      "secret = client.get_secret",
      "client = other_client\n    secret = client.get_secret",
    ),
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
    );
  }
});

test("inline, formatted, extracted, looped, and branched output forms pass", () => {
  const forms = [
    "print(client.get_secret(secret_name).value)",
    'print(f"Value: {client.get_secret(secret_name).value}")',
    "secret = client.get_secret(secret_name)\n    value = secret.value\n    print(value)",
    "for name in [secret_name]:\n        print(client.get_secret(name).value)",
    "if enabled:\n        print(client.get_secret(secret_name).value)\n    else:\n        raise RuntimeError()",
  ];
  for (const body of forms) {
    const source = completeSource.replace(
      "secret = client.get_secret(secret_name)\n    print(secret.value)",
      body,
    );
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      true,
      body,
    );
  }
});

test("branch and loop mutations invalidate later disconnected values", () => {
  for (const mutation of [
    "if changed:\n    client = other_client",
    "for item in items:\n    client = other_client",
    "while changed:\n    secret_name = other_name",
  ]) {
    const source = completeSource.replace(
      "try:",
      `${mutation}\ntry:`,
    );
    assert.equal(
      evaluateRule("prompt/authenticated-operation", workspace(source)),
      false,
      mutation,
    );
  }
});

test("authentication handler must be exact, useful, and connected", () => {
  const invalid = [
    completeSource.replace(
      "except ClientAuthenticationError as error:",
      "except RuntimeError as error:",
    ),
    completeSource.replace(
      "except ClientAuthenticationError as error:",
      "except (ClientAuthenticationError, RuntimeError) as error:",
    ),
    completeSource.replace(
      "print(error, file=sys.stderr)",
      "pass",
    ),
    completeSource.replace(
      "print(error, file=sys.stderr)",
      'print("authentication failed")',
    ),
    completeSource.replace(
      "print(error, file=sys.stderr)",
      "if verbose:\n        print(error, file=sys.stderr)",
    ),
    completeSource.replace(
      "try:\n    secret = client.get_secret(secret_name)",
      "secret = client.get_secret(secret_name)\ntry:\n    unrelated()",
    ),
  ];
  for (const source of invalid) {
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      false,
    );
  }
});

test("relative lookalike authentication exception imports are rejected", () => {
  const source = completeSource.replace(
    "from azure.core.exceptions import ClientAuthenticationError",
    "from .azure.core.exceptions import ClientAuthenticationError",
  );
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(source)),
    false,
  );
});

test("causal authentication handlers and outer handlers pass", () => {
  const bareRaise = completeSource.replace(
    "except ClientAuthenticationError as error:\n    print(error, file=sys.stderr)",
    "except ClientAuthenticationError:\n    raise",
  );
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(bareRaise)),
    true,
  );

  const outer = completeSource.replace(
    `try:
    secret = client.get_secret(secret_name)
    print(secret.value)
except ClientAuthenticationError as error:
    print(error, file=sys.stderr)`,
    `try:
    try:
        secret = client.get_secret(secret_name)
        print(secret.value)
    finally:
        client.close()
except ClientAuthenticationError as error:
    raise RuntimeError("authentication failed") from error`,
  );
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(outer)),
    true,
  );
});

test("every unrelated handler in the operation scope preserves failures", () => {
  const unsafeHandlers = [
    "except RuntimeError as failure:\n    print(failure)",
    "except RuntimeError:\n    return",
    'except RuntimeError as failure:\n    raise RuntimeError("replacement")',
    "except RuntimeError as failure:\n    if retry:\n        raise failure",
    "except RuntimeError as failure:\n    while True:\n        continue",
  ];
  for (const handler of unsafeHandlers) {
    const source = `${completeSource}
try:
    unrelated()
${handler}
`;
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      false,
      handler,
    );
  }

  const safeHandlers = [
    "except RuntimeError:\n    raise",
    "except RuntimeError as failure:\n    raise failure",
    'except RuntimeError as failure:\n    raise RuntimeError("wrapped") from failure',
    `except RuntimeError as failure:
    if wrap:
        raise RuntimeError("wrapped") from failure
    else:
        raise failure`,
  ];
  for (const handler of safeHandlers) {
    const source = `${completeSource}
try:
    unrelated()
${handler}
`;
    assert.equal(
      evaluateRule("prompt/authentication-errors", workspace(source)),
      true,
      handler,
    );
  }
});

test("unsafe catch terminals hidden in loops remain rejected", () => {
  const unsafe = `${completeSource}
try:
    unrelated()
except RuntimeError as failure:
    for item in items:
        if bad(item):
            return
    raise failure
`;
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(unsafe)),
    false,
  );

  const safe = `${completeSource}
try:
    unrelated()
except RuntimeError as failure:
    while should_retry:
        break
    raise failure
`;
  assert.equal(
    evaluateRule("prompt/authentication-errors", workspace(safe)),
    true,
  );
});

test("strings, fake types, disconnected values, and filenames do not score", () => {
  const adversarial = workspace(`
class ClientSecretCredential:
    pass
class SecretClient:
    pass
class ClientAuthenticationError(Exception):
    pass

filename = "identity-python-service-principal-auth.py"
skill = """
import os
from azure.identity import ClientSecretCredential
from azure.keyvault.secrets import SecretClient
credential = ClientSecretCredential(
    os.environ["AZURE_TENANT_ID"],
    os.environ["AZURE_CLIENT_ID"],
    os.environ["AZURE_CLIENT_SECRET"],
)
print(SecretClient(
    os.environ["AZURE_KEY_VAULT_URL"],
    credential,
).get_secret(os.environ["AZURE_KEY_VAULT_SECRET_NAME"]).value)
"""
`);
  for (const rule of ruleNames().filter(
    (name) => name !== "prompt/identity-packages",
  )) {
    assert.equal(evaluateRule(rule, adversarial), false, rule);
  }
});
