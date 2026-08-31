import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadKeyVaultWorkspace,
  ruleNames,
} from "./tools/key-vault-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const goldenWorkspace = loadKeyVaultWorkspace(goldenPath);
const dependencies = goldenWorkspace.dependencies;
const sourceRules = ruleNames().filter(
  (name) => name !== "prompt/key-vault-packages",
);

function workspace(python, manifest = dependencies, filename = "requirements.txt") {
  return {
    dependencies: manifest,
    dependencyManifests: [{ content: manifest, filename }],
    sources: [python],
  };
}

const completeSource = `
import sys
from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

name = "my-secret"
initial = "my-secret-value"
updated = "updated-value"
credential = DefaultAzureCredential()
client = SecretClient(vault_url=vault_url, credential=credential)
try:
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
except ResourceNotFoundError as error:
    print(error, file=sys.stderr)
    raise
`;

const completeAsyncSource = `
import sys
from azure.core.exceptions import ResourceNotFoundError
from azure.identity.aio import DefaultAzureCredential
from azure.keyvault.secrets.aio import SecretClient

name = "my-secret"
initial = "my-secret-value"
updated = "updated-value"

async def main():
    async with DefaultAzureCredential() as credential:
        async with SecretClient(vault_url=vault_url, credential=credential) as client:
            try:
                await client.set_secret(name, initial)
                found = await client.get_secret(name)
                print(found.value)
                await client.set_secret(name, updated)
                poller = await client.begin_delete_secret(name)
                await poller.wait()
                await client.purge_deleted_secret(name)
            except ResourceNotFoundError as error:
                print(error, file=sys.stderr)
                raise

await main()
`;

test("pinned golden passes exactly eight equally weighted rules", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/key-vault-packages",
    "prompt/authenticated-secret-client",
    "prompt/create-secret",
    "prompt/read-secret-value",
    "prompt/update-secret",
    "prompt/begin-delete-secret",
    "prompt/purge-after-delete-completion",
    "prompt/sdk-error-handling",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }
});

test("workspace discovery scores generated source and runtime manifests only", () => {
  const root = fileURLToPath(new URL("./.workspace-fixture", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    mkdirSync(join(root, ".vally", "tools"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    writeFileSync(join(root, "src", "app.py"), completeSource);
    writeFileSync(join(root, "tests", "test_decoy.py"), completeSource);
    writeFileSync(join(root, "generated", "decoy.py"), completeSource);
    writeFileSync(
      join(root, ".vally", "tools", "decoy.py"),
      "def invoke(*args):\n    print(*args)\n",
    );
    writeFileSync(join(root, "README.md"), completeSource);

    const discovered = loadKeyVaultWorkspace(root);
    assert.deepEqual(discovered.pythonFiles, [join(root, "src", "app.py")]);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, discovered), true, rule);
    }

    writeFileSync(join(root, "src", "app.py"), "print('generated')\n");
    const decoysOnly = loadKeyVaultWorkspace(root);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, decoysOnly), false, rule);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty, invalid, comment-only, and prose-only source fail", () => {
  for (const source of [
    "",
    "# DefaultAzureCredential SecretClient set_secret get_secret\n",
    '"""begin_delete_secret wait purge_deleted_secret"""\n',
    "this is not valid Python",
  ]) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace(source)), false, rule);
    }
  }
});

test("runtime package declarations accept standard manifest forms", () => {
  const cases = [
    [
      "requirements-prod.txt",
      "azure_identity[broker]>=1.25\nazure.keyvault.secrets~=4.11",
    ],
    [
      "pyproject.toml",
      `[project]\ndependencies = ["azure-identity>=1.25", "azure-keyvault-secrets>=4.11"]`,
    ],
    [
      "pyproject.toml",
      `[tool.poetry.dependencies]\npython = "^3.11"\nazure-identity = "1.25.3"\nazure-keyvault-secrets = "4.11.2"`,
    ],
    [
      "setup.py",
      `from setuptools import setup\nsetup(install_requires=["azure-identity", "azure-keyvault-secrets"])`,
    ],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/key-vault-packages",
        workspace("print('app')", manifest, filename),
      ),
      true,
      filename,
    );
  }
});

test("prose, dev dependencies, optional groups, and one package fail", () => {
  const cases = [
    ["requirements.txt", "Install azure-identity and azure-keyvault-secrets."],
    ["requirements-dev.txt", "azure-identity\nazure-keyvault-secrets"],
    [
      "pyproject.toml",
      `[project.optional-dependencies]\ndev = ["azure-identity", "azure-keyvault-secrets"]`,
    ],
    ["requirements.txt", "azure-identity==1.25.3"],
    ["requirements.txt", "azure-keyvault-secrets==4.11.2"],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/key-vault-packages",
        workspace("print('app')", manifest, filename),
      ),
      false,
      `${filename}: ${manifest}`,
    );
  }
});

test("each missing lifecycle behavior fails its focused rule", () => {
  const mutations = [
    ["prompt/authenticated-secret-client", "DefaultAzureCredential()", "object()"],
    ["prompt/create-secret", "client.set_secret(name, initial)", "pass"],
    ["prompt/read-secret-value", "print(found.value)", "print('hard-coded')"],
    ["prompt/update-secret", "client.set_secret(name, updated)", "pass"],
    ["prompt/begin-delete-secret", "poller = client.begin_delete_secret(name)", "poller = object()"],
    ["prompt/purge-after-delete-completion", "poller.wait()", "pass"],
    ["prompt/sdk-error-handling", "except ResourceNotFoundError as error:", "except ValueError as error:"],
  ];
  for (const [rule, from, to] of mutations) {
    assert.equal(evaluateRule(rule, workspace(completeSource.replace(from, to))), false, rule);
  }
});

test("qualified async imports, class members, helpers, aliases, and bound calls pass", () => {
  const alternate = workspace(`
import sys
import azure.identity.aio as identity
import azure.keyvault.secrets.aio as secrets
from azure.core import exceptions as errors

SECRET = "my-secret"
FIRST = "my-secret-value"
SECOND = "updated-value"

class Lifecycle:
    def __init__(self, client):
        self.client = client

    async def execute(self):
        create = self.client.set_secret
        read = self.client.get_secret
        update = self.client.set_secret
        remove = self.client.begin_delete_secret
        purge = self.client.purge_deleted_secret
        await create(name=SECRET, value=FIRST)
        response = await read(name=SECRET)
        value = response.value
        print(value)
        await update(SECRET, SECOND)
        pending = await remove(name=SECRET)
        finish = pending.result
        await finish()
        await purge(deleted_secret_name=SECRET)

async def main():
    try:
        async with identity.DefaultAzureCredential() as credential:
            async with secrets.SecretClient("vault-url", credential) as client:
                lifecycle = Lifecycle(client)
                await lifecycle.execute()
    except errors.ResourceNotFoundError as failure:
        print(failure, file=sys.stderr)
        raise

await main()
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("awaited inline, bound intermediate, and helper async lifecycles pass", () => {
  const boundIntermediate = completeAsyncSource
    .replace(
      "await client.set_secret(name, initial)",
      "create = client.set_secret\n                pending_create = create(name, initial)\n                await pending_create",
    )
    .replace(
      "found = await client.get_secret(name)",
      "read = client.get_secret\n                pending_read = read(name)\n                found = await pending_read",
    )
    .replace(
      "poller = await client.begin_delete_secret(name)",
      "remove = client.begin_delete_secret\n                pending_delete = remove(name)\n                poller = await pending_delete",
    )
    .replace(
      "await poller.wait()",
      "finish = poller.result\n                pending_finish = finish()\n                await pending_finish",
    );

  const helpers = `
import sys
from azure.core.exceptions import ResourceNotFoundError
from azure.identity.aio import DefaultAzureCredential
from azure.keyvault.secrets.aio import SecretClient

def create(client):
    return client.set_secret("my-secret", "my-secret-value")

async def read(client):
    return await client.get_secret("my-secret")

async def update(client):
    await client.set_secret("my-secret", "updated-value")

def remove(client):
    return client.begin_delete_secret("my-secret")

def finish(poller):
    return poller.wait()

async def purge(client):
    await client.purge_deleted_secret("my-secret")

async def lifecycle(client):
    pending_create = create(client)
    await pending_create
    found = await read(client)
    print(found.value)
    await update(client)
    poller = await remove(client)
    await finish(poller)
    await purge(client)

async def main():
    async with DefaultAzureCredential() as credential:
        async with SecretClient("vault-url", credential) as client:
            try:
                await lifecycle(client)
            except ResourceNotFoundError as error:
                print(error, file=sys.stderr)
                raise

await main()
`;

  for (const [label, source] of [
    ["inline", completeAsyncSource],
    ["bound intermediate", boundIntermediate],
    ["helper", helpers],
  ]) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, workspace(source)), true, `${label}: ${rule}`);
    }
  }
});

test("a full aio lifecycle without awaits cannot exploit the rules", () => {
  const source = completeAsyncSource
    .replace("await client.set_secret(name, initial)", "client.set_secret(name, initial)")
    .replace("found = await client.get_secret(name)", "found = client.get_secret(name)")
    .replace("await client.set_secret(name, updated)", "client.set_secret(name, updated)")
    .replace(
      "poller = await client.begin_delete_secret(name)",
      "poller = client.begin_delete_secret(name)",
    )
    .replace("await poller.wait()", "poller.wait()")
    .replace(
      "await client.purge_deleted_secret(name)",
      "client.purge_deleted_secret(name)",
    );
  for (const rule of sourceRules.filter(
    (name) => name !== "prompt/authenticated-secret-client",
  )) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test("each unawaited aio operation fails its focused rule", () => {
  const cases = [
    [
      "prompt/create-secret",
      "await client.set_secret(name, initial)",
      "client.set_secret(name, initial)",
    ],
    [
      "prompt/read-secret-value",
      "found = await client.get_secret(name)",
      "found = client.get_secret(name)",
    ],
    [
      "prompt/update-secret",
      "await client.set_secret(name, updated)",
      "client.set_secret(name, updated)",
    ],
    [
      "prompt/begin-delete-secret",
      "poller = await client.begin_delete_secret(name)",
      "poller = client.begin_delete_secret(name)",
    ],
    [
      "prompt/purge-after-delete-completion",
      "await poller.wait()",
      "poller.wait()",
    ],
    [
      "prompt/purge-after-delete-completion",
      "await poller.wait()",
      "poller.result()",
    ],
    [
      "prompt/purge-after-delete-completion",
      "await client.purge_deleted_secret(name)",
      "client.purge_deleted_secret(name)",
    ],
  ];
  for (const [rule, from, to] of cases) {
    assert.equal(
      evaluateRule(rule, workspace(completeAsyncSource.replace(from, to))),
      false,
      `${rule}: ${to}`,
    );
  }
});

test("async helper calls and helper-returned coroutines must be consumed", () => {
  const unawaitedHelper = completeAsyncSource
    .replace(
      `                await client.set_secret(name, initial)
                found = await client.get_secret(name)
                print(found.value)
                await client.set_secret(name, updated)
                poller = await client.begin_delete_secret(name)
                await poller.wait()
                await client.purge_deleted_secret(name)`,
      `                async def lifecycle():
                    await client.set_secret(name, initial)
                    found = await client.get_secret(name)
                    print(found.value)
                    await client.set_secret(name, updated)
                    poller = await client.begin_delete_secret(name)
                    await poller.wait()
                    await client.purge_deleted_secret(name)
                lifecycle()`,
    );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(unawaitedHelper)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/purge-after-delete-completion", workspace(unawaitedHelper)),
    false,
  );

  const returnedCoroutine = completeAsyncSource.replace(
    "await client.set_secret(name, initial)",
    `async def create():
                    return client.set_secret(name, initial)
                await create()`,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(returnedCoroutine)),
    false,
  );
});

test("fake types, lookalike methods, and uncalled helper decoys do not score", () => {
  const fake = workspace(`
class DefaultAzureCredential: pass
class SecretClient:
    def __init__(self, *args, **kwargs): pass
    def set_secret(self, *args): pass
    def get_secret(self, *args): return type("Result", (), {"value": "x"})()
    def begin_delete_secret(self, *args): return self
    def wait(self): pass
    def purge_deleted_secret(self, *args): pass
credential = DefaultAzureCredential()
client = SecretClient("url", credential)
client.set_secret("my-secret", "my-secret-value")
print(client.get_secret("my-secret").value)
client.set_secret("my-secret", "updated-value")
poller = client.begin_delete_secret("my-secret")
poller.wait()
client.purge_deleted_secret("my-secret")
`);
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, fake), false, rule);
  }

  const uncalled = workspace(`
from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient
def decoy():
    client = SecretClient("url", DefaultAzureCredential())
    try:
        client.set_secret("my-secret", "my-secret-value")
        print(client.get_secret("my-secret").value)
        client.set_secret("my-secret", "updated-value")
        poller = client.begin_delete_secret("my-secret")
        poller.wait()
        client.purge_deleted_secret("my-secret")
    except ResourceNotFoundError:
        raise
`);
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, uncalled), false, rule);
  }
});

test("secret names and values preserve exact provenance through reassignment", () => {
  const cases = [
    completeSource.replace('name = "my-secret"', 'name = "other-secret"'),
    completeSource.replace('initial = "my-secret-value"', 'initial = "wrong-value"'),
    completeSource.replace('updated = "updated-value"', 'updated = "wrong-update"'),
    completeSource.replace(
      "client.set_secret(name, initial)",
      'name = "other-secret"\n    client.set_secret(name, initial)',
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/purge-after-delete-completion", workspace(source)),
      false,
    );
  }
});

test("hard-coded output and unrelated retrieved values fail read provenance", () => {
  for (const replacement of [
    'print("my-secret-value")',
    "print(other.value)",
    'print(f"retrieved: updated-value")',
  ]) {
    const source = completeSource.replace("print(found.value)", replacement);
    assert.equal(
      evaluateRule("prompt/read-secret-value", workspace(source)),
      false,
      replacement,
    );
  }
});

test("starred retrieved output preserves provenance", () => {
  const source = completeSource.replace(
    "print(found.value)",
    "print(*[found.value])",
  );
  assert.equal(
    evaluateRule("prompt/read-secret-value", workspace(source)),
    true,
  );
});

test("purge requires the same completed deletion poller in strict order", () => {
  const cases = [
    completeSource.replace(
      "poller.wait()\n    client.purge_deleted_secret(name)",
      "client.purge_deleted_secret(name)\n    poller.wait()",
    ),
    completeSource.replace(
      "poller.wait()",
      "other_poller.wait()",
    ),
    completeSource.replace(
      "client.purge_deleted_secret(name)",
      'client.purge_deleted_secret("other-secret")',
    ),
    completeSource.replace(
      "poller.wait()",
      "client.begin_delete_secret(name).wait()",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/purge-after-delete-completion", workspace(source)),
      false,
    );
  }
});

test("operations on different clients cannot form one lifecycle", () => {
  const source = completeSource
    .replace(
      "try:",
      "other = SecretClient(vault_url=vault_url, credential=credential)\ntry:",
    )
    .replace(
      "poller = client.begin_delete_secret(name)",
      "poller = other.begin_delete_secret(name)",
    );
  assert.equal(
    evaluateRule("prompt/authenticated-secret-client", workspace(source)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/purge-after-delete-completion", workspace(source)),
    false,
  );
});

test("mutually exclusive control-flow branches cannot assemble a lifecycle", () => {
  const source = completeSource.replace(
    `    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)`,
    `    if condition:
        client.set_secret(name, initial)
        found = client.get_secret(name)
        print(found.value)
    else:
        client.set_secret(name, updated)`,
  );
  assert.equal(
    evaluateRule("prompt/update-secret", workspace(source)),
    false,
  );
  assert.equal(
    evaluateRule("prompt/purge-after-delete-completion", workspace(source)),
    false,
  );
});

test("purge hidden in an exception path is not completion ordering", () => {
  const source = completeSource.replace(
    "    client.purge_deleted_secret(name)\nexcept ResourceNotFoundError as error:",
    "except ResourceNotFoundError as error:\n    client.purge_deleted_secret(name)",
  );
  assert.equal(
    evaluateRule("prompt/purge-after-delete-completion", workspace(source)),
    false,
  );
});

test("ResourceNotFoundError must be useful and unrelated handlers rethrow", () => {
  const silent = completeSource.replace(
    "    print(error, file=sys.stderr)\n    raise",
    "    pass",
  );
  assert.equal(evaluateRule("prompt/sdk-error-handling", workspace(silent)), false);

  const swallowedUnrelated = `${completeSource}
try:
    risky()
except ValueError:
    pass
`;
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(swallowedUnrelated)),
    false,
  );

  const preservedUnrelated = `${completeSource}
try:
    risky()
except ValueError as failure:
    raise RuntimeError("unrelated failure") from failure
`;
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(preservedUnrelated)),
    true,
  );
});

test("a reachable helper loop remains valid without filename assumptions", () => {
  const source = completeSource
    .replace(
      "client.set_secret(name, initial)",
      `for operation in [client.set_secret]:
        operation(name, initial)`,
    )
    .replace(
      "poller.wait()",
      `wait_for_completion = poller.wait
    wait_for_completion()`,
    );
  assert.equal(
    evaluateRule("prompt/purge-after-delete-completion", workspace(source)),
    true,
  );
});

test("tri-state guards follow bindings, reassignment, aliases, and operators", () => {
  const lifecycleBody = `    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)`;
  const guarded = (setup, guard) => completeSource.replace(
    `try:
${lifecycleBody}`,
    `${setup}
try:
    if ${guard}:
${lifecycleBody.replace(/^    /gm, "        ")}`,
  );

  const boundFalse = guarded("enabled = False", "enabled");
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(boundFalse)),
    false,
  );

  const unknownReachable = guarded(
    "enabled = external_flag",
    "enabled",
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(unknownReachable),
    ),
    true,
  );

  const operators = guarded(
    "disabled = True\nalias = disabled\ndisabled = False",
    "not (disabled) and (alias or external_flag)",
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(operators),
    ),
    true,
  );
});

test("branch joins merge booleans without reviving false paths", () => {
  const lifecycleBody = `    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)`;
  const joined = (left, right) => completeSource.replace(
    `try:
${lifecycleBody}`,
    `enabled = None
if external_flag:
    enabled = ${left}
else:
    enabled = ${right}
try:
    if enabled:
${lifecycleBody.replace(/^    /gm, "        ")}`,
  );

  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(joined("True", "True")),
    ),
    true,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(joined("False", "False"))),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(joined("True", "False")),
    ),
    true,
  );
});

test("guard termination constrains continuation and cannot combine paths", () => {
  const guardedRaise = completeSource.replace(
    "try:",
    `stop = external_flag
if stop:
    raise RuntimeError("stop")
try:`,
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(guardedRaise),
    ),
    true,
  );

  const guardedReturn = `
import sys
from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

stop = external_flag
name = "my-secret"
initial = "my-secret-value"
updated = "updated-value"
credential = DefaultAzureCredential()
client = SecretClient(vault_url=vault_url, credential=credential)

def run(client):
    if stop:
        return
    try:
        client.set_secret(name, initial)
        found = client.get_secret(name)
        print(found.value)
        client.set_secret(name, updated)
        poller = client.begin_delete_secret(name)
        poller.wait()
        client.purge_deleted_secret(name)
    except ResourceNotFoundError as error:
        print(error, file=sys.stderr)
        raise

run(client)
`;
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(guardedReturn),
    ),
    true,
  );

  const terminated = completeSource.replace(
    `    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)`,
    `    if external_flag:
        client.set_secret(name, initial)
        found = client.get_secret(name)
        print(found.value)
        client.set_secret(name, updated)
        raise RuntimeError("stop")
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)`,
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(terminated),
    ),
    false,
  );
});

test("for loops honor empty literals and conservatively execute unknown iterables", () => {
  const looped = (iterable) => completeSource.replace(
    `try:
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)`,
    `try:
    for item in ${iterable}:
        client.set_secret(name, initial)
        found = client.get_secret(name)
        print(found.value)
        client.set_secret(name, updated)
        poller = client.begin_delete_secret(name)
        poller.wait()
        client.purge_deleted_secret(name)`,
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(looped("[]"))),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(looped("external_items")),
    ),
    true,
  );
});

test("catch bodies require a potentially throwing reachable try", () => {
  const caught = (tryBody) => completeSource.replace(
    `try:
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
except ResourceNotFoundError as error:
    print(error, file=sys.stderr)
    raise`,
    `try:
    ${tryBody}
except ResourceNotFoundError as error:
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
    raise`,
  );
  for (const body of [
    "pass",
    "value = 1",
    "if False:\n        risky()",
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(caught(body))),
      false,
      body,
    );
  }
  const harmless = caught("harmless()").replace(
    "try:",
    "def harmless():\n    value = 1\n\ntry:",
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(harmless)),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(caught("risky()")),
    ),
    true,
  );
});

test("ternary arms and short-circuit helpers preserve path constraints", () => {
  const split = completeSource.replace(
    `try:
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)`,
    `def prefix():
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)

def suffix():
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)

try:
    prefix() if external_flag else suffix()`,
  );
  assert.equal(
    evaluateRule("prompt/purge-after-delete-completion", workspace(split)),
    false,
  );

  const helper = (expression) => completeSource.replace(
    `    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)`,
    "    pass",
  ).replace(
    "try:",
    `def lifecycle():
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
    return True

${expression}
try:`,
  );
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(helper("False and lifecycle()")),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(helper("True or lifecycle()")),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(helper("external_flag and lifecycle()")),
    ),
    true,
  );
});

test("helper boolean arguments substitute into callee guards", () => {
  const guarded = (argument) => completeSource.replace(
    "try:",
    `def lifecycle(enabled):
    if enabled:
        client.set_secret(name, initial)
        found = client.get_secret(name)
        print(found.value)
        client.set_secret(name, updated)
        poller = client.begin_delete_secret(name)
        poller.wait()
        client.purge_deleted_secret(name)

lifecycle(${argument})
try:`,
  ).replace(
    `    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)`,
    "    pass",
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(guarded("False"))),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/create-secret",
      workspace(
        guarded("enabled").replace(
          "lifecycle(enabled)",
          "enabled = False\nlifecycle(enabled)",
        ),
      ),
    ),
    false,
  );
  for (const argument of ["True", "external_flag"]) {
    assert.equal(
      evaluateRule(
        "prompt/purge-after-delete-completion",
        workspace(guarded(argument)),
      ),
      true,
      argument,
    );
  }
});

test("Python helper defaults and folded strings require exact constants", () => {
  const source = (call) => `
import sys
from azure.core.exceptions import ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.keyvault.secrets import SecretClient

credential = DefaultAzureCredential()
client = SecretClient(vault_url=vault_url, credential=credential)

def lifecycle(
    client,
    name="my-" + "secret",
    initial=f'my-{"secret-value"}',
    updated="updated-" + ("value" * 1),
):
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)

try:
    ${call}
except ResourceNotFoundError as error:
    print(error, file=sys.stderr)
    raise
`;
  assert.equal(
    evaluateRule(
      "prompt/purge-after-delete-completion",
      workspace(source("lifecycle(client)")),
    ),
    true,
  );
  assert.equal(
    evaluateRule(
      "prompt/update-secret",
      workspace(source('lifecycle(client, updated="wrong")')),
    ),
    false,
  );

  const reassigned = source("lifecycle(client)").replace(
    "try:",
    'name = "my-secret"\nname = dynamic_name\ntry:',
  ).replace(
    "    name=\"my-\" + \"secret\",",
    "    name=name,",
  );
  assert.equal(
    evaluateRule("prompt/create-secret", workspace(reassigned)),
    false,
  );
});

test("Python try reachability distinguishes throwing and pure helpers", () => {
  const caught = (definitions, body) => completeSource.replace(
    `try:
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
except ResourceNotFoundError as error:
    print(error, file=sys.stderr)
    raise`,
    `${definitions}
try:
    ${body}
except ResourceNotFoundError as error:
    client.set_secret(name, initial)
    found = client.get_secret(name)
    print(found.value)
    client.set_secret(name, updated)
    poller = client.begin_delete_secret(name)
    poller.wait()
    client.purge_deleted_secret(name)
    raise`,
  );
  for (const [definitions, body] of [
    ["", 'raise RuntimeError("boom")'],
    ["def recurse():\n    recurse()\n", "recurse()"],
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/purge-after-delete-completion",
        workspace(caught(definitions, body)),
      ),
      true,
      body,
    );
  }
  for (const [definitions, body] of [
    ["", "enabled = False\n    if enabled:\n        risky()"],
    ["def pure():\n    return\n    risky()\n", "pure()"],
  ]) {
    assert.equal(
      evaluateRule("prompt/create-secret", workspace(caught(definitions, body))),
      false,
      body,
    );
  }
});
