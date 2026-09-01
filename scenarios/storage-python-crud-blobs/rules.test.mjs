import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  loadStorageBlobsWorkspace,
  ruleNames,
} from "./tools/storage-blobs-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const goldenWorkspace = loadStorageBlobsWorkspace(goldenPath);
const completeSource = readFileSync(
  join(goldenPath, "blob_crud.py"),
  "utf8",
).replaceAll("\r\n", "\n");
const dependencies = goldenWorkspace.dependencies;
const sourceRules = ruleNames().filter(
  (name) => name !== "prompt/sdk-packages",
);
const languageChecks = [
  "language/correct-imports",
  "language/default-azure-credential",
  "language/client-lifecycle",
  "language/async-client",
  "language/exception-handling",
];

function workspace(
  python,
  manifest = dependencies,
  filename = "requirements.txt",
) {
  return {
    dependencies: manifest,
    dependencyManifests: [{ content: manifest, filename }],
    documents: [{ path: "application.py", source: python }],
  };
}

function documentWorkspace(documents, manifest = dependencies) {
  return {
    dependencies: manifest,
    dependencyManifests: [
      { content: manifest, filename: "requirements.txt" },
    ],
    documents,
  };
}

test.skip("pinned golden passes every prompt and shared Python rule", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-packages",
    "prompt/authenticated-blob-service-client",
    "prompt/create-container",
    "prompt/upload-blob",
    "prompt/list-blobs",
    "prompt/download-blob",
    "prompt/delete-blob-and-container",
    "prompt/sdk-error-handling",
  ]);
  assert.equal(
    dependencies.replaceAll("\r\n", "\n"),
    "azure-identity==1.25.3\nazure-storage-blob==12.30.1\n",
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }

  const sharedWorkspace = loadPythonWorkspace(goldenPath);
  for (const check of languageChecks) {
    assert.equal(evaluatePythonCheck(check, sharedWorkspace), true, check);
  }
});

test.skip("each missing lifecycle behavior fails its focused rule", () => {
  const mutations = [
    [
      "prompt/authenticated-blob-service-client",
      "credential=credential,",
      'credential="account-key",',
    ],
    [
      "prompt/create-container",
      "ResourceExistsError",
      "ValueError",
    ],
    [
      "prompt/upload-blob",
      "overwrite=True",
      "overwrite=False",
    ],
    [
      "prompt/list-blobs",
      'print(f"{blob.name}: {blob.size}")',
      "print(blob.name)",
    ],
    [
      "prompt/download-blob",
      'open(DOWNLOAD_PATH, "wb")',
      'open("wrong.csv", "wb")',
    ],
    [
      "prompt/delete-blob-and-container",
      "blob_client.delete_blob()\n                container_client.delete_container()",
      "container_client.delete_container()\n                blob_client.delete_blob()",
    ],
    [
      "prompt/sdk-error-handling",
      "except HttpResponseError as error:",
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

  assert.equal(
    evaluateRule(
      "prompt/sdk-packages",
      workspace(
        completeSource,
        "azure-identity==1.25.3\n",
      ),
    ),
    false,
  );
});

test.skip("comments, strings, invalid syntax, and local fake clients cannot pass", () => {
  const fake = `
class DefaultAzureCredential:
    pass

class BlobServiceClient:
    def __init__(self, *args, **kwargs):
        self.container = self
    def get_container_client(self, name):
        return self.container
    def create_container(self):
        return None
    def get_blob_client(self, name):
        return self
    def upload_blob(self, data, overwrite=False):
        return None
    def list_blobs(self):
        return []
    def download_blob(self):
        return self
    def readinto(self, stream):
        return 0
    def delete_blob(self):
        return None
    def delete_container(self):
        return None

credential = DefaultAzureCredential()
client = BlobServiceClient("https://example.invalid", credential)
`;
  for (const source of [
    "",
    "# BlobServiceClient upload_blob download_blob delete_blob\n",
    '"""DefaultAzureCredential ResourceExistsError HttpResponseError"""\n',
    "this is not valid Python",
    fake,
  ]) {
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, workspace(source)), false, rule);
    }
  }
});

test.skip("uncalled helpers and statements after return cannot satisfy rules", () => {
  const lifecycleBody = completeSource
    .replace(
      "def run() -> None:\n",
      "def disconnected() -> None:\n",
    )
    .replace('\n\nif __name__ == "__main__":\n    run()\n', "\n");
  const uncalled = `${lifecycleBody}\nprint("application")\n`;
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(uncalled)), false, rule);
  }

  const afterReturn = completeSource.replace(
    "def run() -> None:\n",
    "def run() -> None:\n    return\n",
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace(afterReturn)), false, rule);
  }
});

test.skip("operations on disconnected service clients do not form a lifecycle", () => {
  const disconnected = completeSource.replace(
    "container_client = service_client.get_container_client(CONTAINER_NAME)",
    `container_client = service_client.get_container_client(CONTAINER_NAME)
            second_service = BlobServiceClient(
                account_url=account_url,
                credential=credential,
            )`,
  ).replace(
    "blob_client = container_client.get_blob_client(BLOB_NAME)",
    `container_client = second_service.get_container_client(CONTAINER_NAME)
                blob_client = container_client.get_blob_client(BLOB_NAME)`,
  );

  assert.equal(
    evaluateRule("prompt/authenticated-blob-service-client", workspace(disconnected)),
    true,
  );
  for (const rule of [
    "prompt/upload-blob",
    "prompt/list-blobs",
    "prompt/download-blob",
    "prompt/delete-blob-and-container",
  ]) {
    assert.equal(evaluateRule(rule, workspace(disconnected)), false, rule);
  }
});

test.skip("authenticated clients require a connected account URL", () => {
  const missingUrl = completeSource.replace(
    `account_url=account_url,
            credential=credential,`,
    "credential=credential,",
  );
  assert.equal(
    evaluateRule(
      "prompt/authenticated-blob-service-client",
      workspace(missingUrl),
    ),
    false,
  );

  const invalidUrl = completeSource.replace(
    "account_url=account_url,",
    'account_url="not-a-url",',
  );
  assert.equal(
    evaluateRule(
      "prompt/authenticated-blob-service-client",
      workspace(invalidUrl),
    ),
    false,
  );

  const positionalUrl = completeSource.replace(
    `account_url=account_url,
            credential=credential,`,
    `account_url,
            credential,`,
  );
  assert.equal(
    evaluateRule(
      "prompt/authenticated-blob-service-client",
      workspace(positionalUrl),
    ),
    true,
  );
});

test.skip("aliases, direct service operations, Path I/O, and keyword calls pass", () => {
  const alternate = workspace(`
import sys
import azure.core.exceptions as errors
import azure.identity as identity
import azure.storage.blob as storage
from pathlib import Path

CONTAINER = "my-" + "container"
BLOB = "reports/" + "report.csv"

def execute(service):
    try:
        try:
            service.create_container(name=CONTAINER)
        except errors.ResourceExistsError:
            pass

        container = service.get_container_client(container=CONTAINER)
        blob = service.get_blob_client(container=CONTAINER, blob=BLOB)
        blob.upload_blob(
            data=Path("report.csv").read_bytes(),
            overwrite=True,
        )
        for item in container.list_blobs():
            name = item.name
            length = item.content_length
            print(name, length)
        downloader = container.download_blob(blob=BLOB)
        with Path("report-downloaded.csv").open("wb") as destination:
            destination.write(downloader.readall())
        container.delete_blob(blob=BLOB)
        service.delete_container(container=CONTAINER)
    except errors.HttpResponseError as failure:
        print(failure, file=sys.stderr)
        raise

credential = identity.DefaultAzureCredential()
service = storage.BlobServiceClient(
    account_url=account_url,
    credential=credential,
)
execute(service)
service.close()
credential.close()
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test.skip("valid asynchronous SDK forms pass prompt rules", () => {
  const alternate = workspace(`
import asyncio
import sys
from azure.core.exceptions import HttpResponseError, ResourceExistsError
from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob.aio import BlobServiceClient

async def main():
    credential = DefaultAzureCredential()
    service = BlobServiceClient(account_url=account_url, credential=credential)
    container = service.get_container_client("my-container")
    try:
        try:
            await container.create_container()
        except ResourceExistsError:
            pass
        blob = container.get_blob_client("reports/report.csv")
        with open("report.csv", "rb") as source:
            await blob.upload_blob(source, overwrite=True)
        async for item in container.list_blobs():
            print(item.name)
            print(item.size)
        with open("report-downloaded.csv", "wb") as destination:
            await (await blob.download_blob()).readinto(destination)
        await blob.delete_blob()
        await container.delete_container()
    except HttpResponseError as failure:
        print(failure, file=sys.stderr)
        raise
    await service.close()
    await credential.close()

asyncio.run(main())
`);
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test.skip("runtime dependency manifests accept equivalent active forms", () => {
  const cases = [
    [
      "requirements-prod.txt",
      "azure_identity[broker]>=1.25\nazure.storage.blob~=12.30",
    ],
    [
      "pyproject.toml",
      `[project]\ndependencies = ["azure-identity>=1.25", "azure-storage-blob>=12.30"]`,
    ],
    [
      "pyproject.toml",
      `[tool.poetry.dependencies]\npython = "^3.11"\nazure-identity = "1.25.3"\nazure-storage-blob = "12.30.1"`,
    ],
    [
      "setup.py",
      `from setuptools import setup\nsetup(install_requires=["azure-identity", "azure-storage-blob"])`,
    ],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/sdk-packages",
        workspace("print('application')", manifest, filename),
      ),
      true,
      filename,
    );
  }
});

test.skip("dev-only, optional, commented, prose, and partial packages fail", () => {
  const cases = [
    ["requirements.txt", "Install azure-identity and azure-storage-blob."],
    ["requirements-dev.txt", "azure-identity\nazure-storage-blob"],
    [
      "pyproject.toml",
      `[project.optional-dependencies]\ndev = ["azure-identity", "azure-storage-blob"]`,
    ],
    ["requirements.txt", "# azure-identity\n# azure-storage-blob"],
    ["requirements.txt", "azure-identity==1.25.3"],
    ["requirements.txt", "azure-storage-blob==12.30.1"],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/sdk-packages",
        workspace("print('application')", manifest, filename),
      ),
      false,
      filename,
    );
  }
});

test.skip("workspace discovery ignores tests, caches, generated files, and skills", () => {
  const root = fileURLToPath(new URL("./.workspace-fixture", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    mkdirSync(join(root, ".vally"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    writeFileSync(join(root, "application.py"), completeSource);
    writeFileSync(join(root, "tests", "test_decoy.py"), completeSource);
    writeFileSync(join(root, "generated", "decoy.py"), completeSource);
    writeFileSync(join(root, ".vally", "skill.py"), completeSource);

    const discovered = loadStorageBlobsWorkspace(root);
    assert.deepEqual(discovered.topLevelPythonFiles, [
      join(root, "application.py"),
    ]);
    assert.deepEqual(discovered.pythonFiles, [join(root, "application.py")]);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, discovered), true, rule);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skip("a local azure.storage.blob module cannot impersonate the SDK", () => {
  const shadowed = documentWorkspace([
    { path: "src/azure/storage/blob.py", source: "" },
    { path: "src/application.py", source: completeSource },
  ]);
  assert.equal(
    evaluateRule("prompt/authenticated-blob-service-client", shadowed),
    false,
  );
  assert.equal(evaluateRule("prompt/create-container", shadowed), false);
});
