import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateRule,
  loadStorageAccountWorkspace,
  ruleNames,
} from "./tools/storage-account-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const goldenWorkspace = loadStorageAccountWorkspace(goldenPath);
const dependencies = goldenWorkspace.dependencies;
const completeSource = readFileSync(
  join(goldenPath, "storage_account_management.py"),
  "utf8",
).replaceAll("\r\n", "\n");
const sourceRules = ruleNames().filter(
  (name) => name !== "prompt/sdk-packages",
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

function documentWorkspace(documents, manifest = dependencies) {
  return {
    dependencies: manifest,
    dependencyManifests: [
      { content: manifest, filename: "requirements.txt" },
    ],
    documents,
    sources: documents.map((document) => document.source),
  };
}

test("pinned golden passes exactly nine equally weighted rules", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-packages",
    "prompt/configuration",
    "prompt/authenticated-management-client",
    "prompt/create-storage-account",
    "prompt/list-storage-accounts",
    "prompt/get-storage-account-properties",
    "prompt/enable-blob-versioning",
    "prompt/delete-storage-account",
    "prompt/sdk-error-handling",
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }
});

test("workspace discovery scores generated source and root manifests only", () => {
  const root = fileURLToPath(new URL("./.workspace-fixture", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "cache"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    mkdirSync(join(root, ".vally"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    writeFileSync(join(root, "src", "application.py"), completeSource);
    writeFileSync(join(root, "tests", "test_decoy.py"), completeSource);
    writeFileSync(join(root, "cache", "decoy.py"), completeSource);
    writeFileSync(join(root, "generated", "decoy.py"), completeSource);
    writeFileSync(join(root, ".vally", "skill.py"), completeSource);
    writeFileSync(join(root, "README.md"), completeSource);

    const discovered = loadStorageAccountWorkspace(root);
    assert.deepEqual(discovered.pythonFiles, [
      join(root, "src", "application.py"),
    ]);
    assert.deepEqual(discovered.documents, [
      {
        path: "src/application.py",
        source: completeSource,
      },
    ]);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, discovered), true, rule);
    }

    writeFileSync(join(root, "src", "application.py"), "print('generated')\n");
    const decoysOnly = loadStorageAccountWorkspace(root);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, decoysOnly), false, rule);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty, invalid, comment-only, prose-only, and fake SDK source fail", () => {
  const fake = `
import os
class DefaultAzureCredential: pass
class StorageManagementClient:
    def __init__(self, *args):
        self.storage_accounts = self
        self.blob_services = self
    def begin_create(self, *args): return self
    def result(self): return self
    def list_by_resource_group(self, *args): return [self]
    def get_properties(self, *args): return self
    def set_service_properties(self, *args): return self
    def begin_delete(self, *args): return self
subscription = os.environ["AZURE_SUBSCRIPTION_ID"]
group = os.environ["AZURE_RESOURCE_GROUP_NAME"]
account = os.environ["AZURE_STORAGE_ACCOUNT_NAME"]
location = os.environ.get("AZURE_LOCATION", "eastus")
client = StorageManagementClient(DefaultAzureCredential(), subscription)
`;
  for (const source of [
    "",
    "# StorageManagementClient begin_create begin_delete\n",
    '"""DefaultAzureCredential HttpResponseError"""\n',
    "this is not valid Python",
  ]) {
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, workspace(source)), false, rule);
    }
  }
  assert.equal(
    evaluateRule("prompt/configuration", workspace(fake)),
    true,
  );
  for (const rule of sourceRules.filter(
    (name) => name !== "prompt/configuration",
  )) {
    assert.equal(evaluateRule(rule, workspace(fake)), false, rule);
  }
});

test("runtime package declarations accept active standard manifest forms", () => {
  const cases = [
    [
      "requirements-prod.txt",
      "azure_identity[broker]>=1.25\nazure.mgmt.storage~=25.1",
    ],
    [
      "pyproject.toml",
      `[project]\ndependencies = ["azure-identity>=1.25", "azure-mgmt-storage>=25.1"]`,
    ],
    [
      "pyproject.toml",
      `[tool.poetry.dependencies]\npython = "^3.11"\nazure-identity = "1.25.3"\nazure-mgmt-storage = "25.1.0"`,
    ],
    [
      "setup.py",
      `from setuptools import setup\nsetup(install_requires=["azure-identity", "azure-mgmt-storage"])`,
    ],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/sdk-packages",
        workspace("print('app')", manifest, filename),
      ),
      true,
      filename,
    );
  }
});

test("prose, dev manifests, optional groups, comments, and one package fail", () => {
  const cases = [
    ["requirements.txt", "Install azure-identity and azure-mgmt-storage."],
    ["requirements-dev.txt", "azure-identity\nazure-mgmt-storage"],
    [
      "pyproject.toml",
      `[project.optional-dependencies]\ndev = ["azure-identity", "azure-mgmt-storage"]`,
    ],
    ["requirements.txt", "# azure-identity\n# azure-mgmt-storage"],
    ["requirements.txt", "azure-identity==1.25.3"],
    ["requirements.txt", "azure-mgmt-storage==25.1.0"],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/sdk-packages",
        workspace("print('app')", manifest, filename),
      ),
      false,
      `${filename}: ${manifest}`,
    );
  }
});

test("each missing lifecycle behavior fails its focused rule", () => {
  const mutations = [
    [
      "prompt/configuration",
      'os.environ["AZURE_STORAGE_ACCOUNT_NAME"]',
      'os.environ["STORAGE_ACCOUNT_NAME"]',
    ],
    [
      "prompt/authenticated-management-client",
      "StorageManagementClient(credential, subscription_id)",
      'StorageManagementClient(credential, "hard-coded")',
    ],
    [
      "prompt/create-storage-account",
      "creation.result()",
      "creation.wait()",
    ],
    [
      "prompt/list-storage-accounts",
      "for account in client.storage_accounts.list_by_resource_group(",
      "for account in []: # ",
    ],
    [
      "prompt/get-storage-account-properties",
      'print(f"Storage account location: {properties.location}")',
      'print("Storage account retrieved")',
    ],
    [
      "prompt/enable-blob-versioning",
      "is_versioning_enabled=True",
      "is_versioning_enabled=False",
    ],
    [
      "prompt/delete-storage-account",
      "deletion.result()",
      "deletion.wait()",
    ],
    [
      "prompt/sdk-error-handling",
      "except ClientAuthenticationError as error:",
      "except ValueError as error:",
    ],
  ];
  for (const [rule, from, to] of mutations) {
    assert.equal(
      evaluateRule(rule, workspace(completeSource.replace(from, to))),
      false,
      rule,
    );
  }
});

test("qualified imports, aliases, helpers, dict models, and constants pass", () => {
  const alternate = workspace(`
import os
import sys
import azure.identity as identity
import azure.mgmt.storage as storage
import azure.mgmt.storage.models as models
from azure.core import exceptions as errors

SUBSCRIPTION = os.environ["AZURE_SUBSCRIPTION_ID"]
GROUP = os.environ["AZURE_RESOURCE_GROUP_NAME"]
ACCOUNT = os.environ["AZURE_STORAGE_ACCOUNT_NAME"]
LOCATION = os.environ.get("AZURE_LOCATION", "east" + "us")

def finish(poller):
    return poller.result()

class Lifecycle:
    def __init__(self, client):
        self.accounts = client.storage_accounts
        self.blobs = client.blob_services

    def execute(self):
        create = self.accounts.begin_create
        created = create(
            GROUP,
            ACCOUNT,
            {
                "sku": {"name": "Standard_LRS"},
                "kind": "StorageV2",
                "location": LOCATION,
            },
        )
        finish(created)
        listing = self.accounts.list_by_resource_group(GROUP)
        print([item.name for item in listing])
        read = self.accounts.get_properties
        found = read(resource_group_name=GROUP, account_name=ACCOUNT)
        print(found.kind)
        changed = self.blobs.set_service_properties(
            GROUP,
            ACCOUNT,
            "default",
            {"is_versioning_enabled": True},
        )
        print(changed.is_versioning_enabled)
        remove = self.accounts.begin_delete(GROUP, ACCOUNT)
        finish(remove)
        print("deleted:", ACCOUNT)

def main():
    credential = identity.DefaultAzureCredential()
    client = storage.StorageManagementClient(
        credential=credential,
        subscription_id=SUBSCRIPTION,
    )
    try:
        Lifecycle(client).execute()
    except errors.ClientAuthenticationError as failure:
        print(failure, file=sys.stderr)
        raise
    except errors.HttpResponseError as failure:
        print(failure, file=sys.stderr)
        raise

main()
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("valid multi-file SDK imports and relative helpers pass", () => {
  const lifecycle = completeSource.replace(
    '\n\nif __name__ == "__main__":\n    run()\n',
    "\n",
  );
  const split = documentWorkspace([
    { path: "src/storage_app/__init__.py", source: "" },
    {
      path: "src/storage_app/lifecycle.py",
      source: lifecycle,
    },
    {
      path: "src/storage_app/main.py",
      source: `from . import lifecycle

lifecycle.run()
`,
    },
  ]);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, split), true, rule);
  }
});

test("local Azure modules and packages fail SDK import provenance", () => {
  const cases = [
    ["azure.py", "application.py"],
    ["azure/__init__.py", "application.py"],
    ["azure/identity.py", "application.py"],
    ["azure/identity/__init__.py", "application.py"],
    ["azure/mgmt.py", "application.py"],
    ["azure/mgmt/__init__.py", "application.py"],
    ["azure/mgmt/storage.py", "application.py"],
    ["azure/mgmt/storage/__init__.py", "application.py"],
    ["src\\azure.py", "src\\application.py"],
    ["src/azure/identity.py", "src/application.py"],
    ["src/azure/mgmt/storage.py", "src/application.py"],
  ];
  for (const [shadowPath, applicationPath] of cases) {
    const shadowed = documentWorkspace([
      { path: shadowPath, source: "" },
      { path: applicationPath, source: completeSource },
    ]);
    assert.equal(
      evaluateRule("prompt/authenticated-management-client", shadowed),
      false,
      shadowPath,
    );
    assert.equal(
      evaluateRule("prompt/create-storage-account", shadowed),
      false,
      shadowPath,
    );
    assert.equal(
      evaluateRule("prompt/sdk-error-handling", shadowed),
      false,
      shadowPath,
    );
  }
});

test("local async Azure modules and packages fail import provenance", () => {
  const asyncImports = `
import os
from azure.identity.aio import DefaultAzureCredential
from azure.mgmt.storage.aio import StorageManagementClient

subscription = os.environ["AZURE_SUBSCRIPTION_ID"]
credential = DefaultAzureCredential()
client = StorageManagementClient(credential, subscription)
`;
  assert.equal(
    evaluateRule(
      "prompt/authenticated-management-client",
      documentWorkspace([
        { path: "src/application.py", source: asyncImports },
      ]),
    ),
    true,
  );
  for (const shadowPath of [
    "src/azure/identity/aio.py",
    "src/azure/identity/aio/__init__.py",
    "src/azure/mgmt/storage/aio.py",
    "src/azure/mgmt/storage/aio/__init__.py",
  ]) {
    assert.equal(
      evaluateRule(
        "prompt/authenticated-management-client",
        documentWorkspace([
          { path: shadowPath, source: "" },
          { path: "src/application.py", source: asyncImports },
        ]),
      ),
      false,
      shadowPath,
    );
  }
});

test("unrelated Azure-like paths do not affect behavioral scoring", () => {
  const cases = [
    "azure_helpers.py",
    "tools/azure.py",
    "azure/storage_helpers.py",
    "src/azure/identity.py",
    "azure.py",
  ];
  for (const unrelatedPath of cases) {
    const applicationPath =
      unrelatedPath === "azure.py"
        ? "src/application.py"
        : "application.py";
    const valid = documentWorkspace([
      { path: unrelatedPath, source: "VALUE = 1\n" },
      { path: applicationPath, source: completeSource },
    ]);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, valid), true, `${unrelatedPath}: ${rule}`);
    }
  }
});

test("valid async clients, pollers, iteration, and SDK calls pass", () => {
  const alternate = workspace(`
import asyncio
import os
import sys
from azure.core.exceptions import ClientAuthenticationError, HttpResponseError
from azure.identity.aio import DefaultAzureCredential
from azure.mgmt.storage.aio import StorageManagementClient
from azure.mgmt.storage.models import BlobServiceProperties

async def main():
    subscription = os.environ["AZURE_SUBSCRIPTION_ID"]
    group = os.environ["AZURE_RESOURCE_GROUP_NAME"]
    account = os.environ["AZURE_STORAGE_ACCOUNT_NAME"]
    location = os.environ.get("AZURE_LOCATION", "eastus")
    credential = DefaultAzureCredential()
    client = StorageManagementClient(credential, subscription)
    try:
        create = await client.storage_accounts.begin_create(
            group,
            account,
            {
                "sku": {"name": "Standard_LRS"},
                "kind": "StorageV2",
                "location": location,
            },
        )
        await create.result()
        async for item in client.storage_accounts.list_by_resource_group(group):
            print(item.name)
        found = await client.storage_accounts.get_properties(group, account)
        print(found.provisioning_state)
        changed = await client.blob_services.set_service_properties(
            group,
            account,
            "default",
            BlobServiceProperties(is_versioning_enabled=True),
        )
        print(changed.is_versioning_enabled)
        remove = await client.storage_accounts.begin_delete(group, account)
        await remove.result()
        print(account)
    except ClientAuthenticationError as error:
        print(error, file=sys.stderr)
        raise
    except HttpResponseError as error:
        print(error, file=sys.stderr)
        raise

asyncio.run(main())
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("exact configuration and operation provenance are required", () => {
  const cases = [
    completeSource.replace(
      'os.environ.get("AZURE_LOCATION", "eastus")',
      'os.environ.get("AZURE_LOCATION", "westus")',
    ),
    completeSource.replace("location=location", 'location="eastus"'),
    completeSource.replace(
      "resource_group_name,\n            account_name,\n            parameters,",
      '"hard-coded-group",\n            account_name,\n            parameters,',
    ),
    completeSource.replace(
      "resource_group_name,\n            account_name,\n        )",
      'resource_group_name,\n            "hardcodedaccount",\n        )',
    ),
    completeSource.replace(
      "credential, subscription_id",
      "credential, account_name",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/delete-storage-account", workspace(source)),
      false,
    );
  }
});

test("create requires Standard_LRS StorageV2, configured location, and no tier", () => {
  const cases = [
    completeSource.replace("SkuName.STANDARD_LRS", '"Standard_GRS"'),
    completeSource.replace("Kind.STORAGE_V2", '"BlobStorage"'),
    completeSource.replace(
      "location=location,",
      'location=location,\n            access_tier="Hot",',
    ),
    completeSource.replace(
      "parameters = StorageAccountCreateParameters(",
      "parameters = BlobServiceProperties(",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/create-storage-account", workspace(source)),
      false,
    );
  }
});

test("list and get require result-derived nonsecret output", () => {
  const cases = [
    [
      "prompt/list-storage-accounts",
      completeSource.replace(
        'print(f"Storage account: {account.name}")',
        'print("Storage account")',
      ),
    ],
    [
      "prompt/get-storage-account-properties",
      completeSource.replace(
        'print(f"Storage account location: {properties.location}")',
        "print(properties.keys)",
      ),
    ],
    [
      "prompt/get-storage-account-properties",
      completeSource.replace(
        'print(f"Storage account location: {properties.location}")',
        "print(account_name)",
      ),
    ],
  ];
  for (const [rule, source] of cases) {
    assert.equal(evaluateRule(rule, workspace(source)), false, rule);
  }
});

test("blob versioning requires same account, default service, true, and output", () => {
  const cases = [
    completeSource.replace(
      "account_name,\n            \"default\",\n            BlobServiceProperties",
      '"otheraccount",\n            "default",\n            BlobServiceProperties',
    ),
    completeSource.replace('"default"', '"other"'),
    completeSource.replace(
      'print(f"Blob versioning enabled: {blob_properties.is_versioning_enabled}")',
      'print("Blob versioning enabled")',
    ),
    completeSource.replace(
      "client.blob_services.set_service_properties(",
      "client.blob_services.get_service_properties(",
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/enable-blob-versioning", workspace(source)),
      false,
    );
  }
});

test("forbidden resource group, key, and access-tier operations fail lifecycle", () => {
  const cases = [
    completeSource.replace(
      "from azure.mgmt.storage import StorageManagementClient",
      `from azure.mgmt.storage import StorageManagementClient
from azure.mgmt.resource import ResourceManagementClient`,
    ).replace(
      "credential = DefaultAzureCredential()",
      `credential = DefaultAzureCredential()
    ResourceManagementClient(credential, subscription_id)`,
    ),
    completeSource.replace(
      "properties = client.storage_accounts.get_properties(",
      `client.storage_accounts.list_keys(resource_group_name, account_name)
        properties = client.storage_accounts.get_properties(`,
    ),
    completeSource.replace(
      "properties = client.storage_accounts.get_properties(",
      `client.resource_groups.create_or_update(resource_group_name, {})
        properties = client.storage_accounts.get_properties(`,
    ),
    completeSource.replace(
      "location=location,",
      'location=location,\n            access_tier="Cool",',
    ),
    completeSource.replace(
      "parameters = StorageAccountCreateParameters(",
      `parameters = {
            "sku": {"name": "Standard_LRS"},
            "kind": "StorageV2",
            "location": location,
            "accessTier": "Hot",
        }
        unused = StorageAccountCreateParameters(`,
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/delete-storage-account", workspace(source)),
      false,
    );
  }
});

test("poller identity, result method, order, and confirmation are exact", () => {
  const cases = [
    completeSource.replace("creation.result()", "other.result()"),
    completeSource.replace("creation.result()", "creation.wait()"),
    completeSource.replace("deletion.result()", "other.result()"),
    completeSource.replace("deletion.result()", "deletion.wait()"),
    completeSource.replace(
      `deletion.result()
        print(f"Deleted storage account: {account_name}")`,
      `print(f"Deleted storage account: {account_name}")
        deletion.result()`,
    ),
    completeSource.replace(
      'print(f"Deleted storage account: {account_name}")',
      'print("Deleted storage account")',
    ),
    completeSource.replace(
      "deletion.result()",
      `client.storage_accounts.begin_delete(
            resource_group_name,
            account_name,
        ).result()`,
    ),
  ];
  for (const source of cases) {
    assert.equal(
      evaluateRule("prompt/delete-storage-account", workspace(source)),
      false,
    );
  }
});

test("source order, mutually exclusive paths, and uncalled helpers fail", () => {
  const reordered = completeSource.replace(
    `creation.result()

        for account in client.storage_accounts.list_by_resource_group(`,
    `for account in client.storage_accounts.list_by_resource_group(`,
  ).replace(
    `        properties = client.storage_accounts.get_properties(`,
    `        creation.result()

        properties = client.storage_accounts.get_properties(`,
  );
  assert.equal(
    evaluateRule("prompt/list-storage-accounts", workspace(reordered)),
    false,
  );

  const exclusive = completeSource.replace(
    `        creation = client.storage_accounts.begin_create(
            resource_group_name,
            account_name,
            parameters,
        )
        creation.result()

        for account in client.storage_accounts.list_by_resource_group(
            resource_group_name,
        ):
            print(f"Storage account: {account.name}")`,
    `        if external_flag:
            creation = client.storage_accounts.begin_create(
                resource_group_name,
                account_name,
                parameters,
            )
            creation.result()
        else:
            for account in client.storage_accounts.list_by_resource_group(
                resource_group_name,
            ):
                print(account.name)`,
  );
  assert.equal(
    evaluateRule("prompt/list-storage-accounts", workspace(exclusive)),
    false,
  );

  const uncalled = completeSource.replace(
    'if __name__ == "__main__":\n    run()',
    'if __name__ == "__main__":\n    pass',
  );
  assert.equal(
    evaluateRule("prompt/create-storage-account", workspace(uncalled)),
    false,
  );
});

test("meaningful HTTP and authentication diagnostics are both required", () => {
  const failures = [
    completeSource.replace(
      '        print(f"Azure authentication failed: {error}", file=sys.stderr)\n        raise',
      "        raise",
    ),
    completeSource.replace(
      "except ClientAuthenticationError as error:",
      "except ClientAuthenticationError:",
    ),
    completeSource.replace(
      '        print(f"Storage management request failed: {error}", file=sys.stderr)\n        raise',
      '        print("request failed", file=sys.stderr)\n        raise',
    ),
    completeSource.replace(
      '        print(f"Storage management request failed: {error}", file=sys.stderr)\n        raise',
      "        print(error)\n        pass",
    ),
    completeSource.replace(
      "except HttpResponseError as error:",
      "except (HttpResponseError, ValueError) as error:",
    ),
    `${completeSource}
try:
    risky()
except ValueError:
    pass
`,
  ];
  for (const source of failures) {
    assert.equal(
      evaluateRule("prompt/sdk-error-handling", workspace(source)),
      false,
    );
  }
});

test("direct, logger, and reachable helper error diagnostics pass", () => {
  const source = completeSource
    .replace("import sys", "import sys\nimport logging")
    .replace(
      "def run() -> None:",
      `def report(failure):
    logging.error("%s", failure.message)

def run() -> None:`,
    )
    .replace(
      'print(f"Azure authentication failed: {error}", file=sys.stderr)',
      "report(error)",
    )
    .replace(
      'print(f"Storage management request failed: {error}", file=sys.stderr)',
      "sys.stderr.write(str(error))",
    );
  assert.equal(
    evaluateRule("prompt/sdk-error-handling", workspace(source)),
    true,
  );
});
