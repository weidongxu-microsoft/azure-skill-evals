import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  evaluatePythonCheck,
  loadPythonWorkspace,
} from "../../languages/python/checks.mjs";
import {
  evaluateRule,
  loadStorageBlobManagerWorkspace,
  ruleNames,
} from "./tools/storage-blob-manager-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const checkScript = fileURLToPath(
  new URL("./tools/check-storage-blob-manager-python.mjs", import.meta.url),
);
const goldenWorkspace = loadStorageBlobManagerWorkspace(goldenPath);
const languageWorkspace = loadPythonWorkspace(goldenPath);
const dependencies = goldenWorkspace.dependencies.replaceAll("\r\n", "\n");
const languageChecks = [
  "language/correct-imports",
  "language/default-azure-credential",
  "language/client-lifecycle",
  "language/async-client",
  "language/exception-handling",
];
const sourceRules = ruleNames().filter((name) => name !== "prompt/sdk-packages");
const documents = Object.fromEntries(
  goldenWorkspace.documents.map((document) => [
    document.path,
    document.source.replaceAll("\r\n", "\n"),
  ]),
);

function workspaceWithDocuments(updatedDocuments, manifest = dependencies) {
  return {
    dependencies: manifest,
    dependencyManifests: [{ content: manifest, filename: "requirements.txt" }],
    documents: updatedDocuments.map((document) => ({ ...document })),
  };
}

function replaceDocument(path, from, to, baseDocuments = goldenWorkspace.documents) {
  const documents = baseDocuments.map((document) =>
    document.path === path
      ? {
          ...document,
          source: document.source.replaceAll("\r\n", "\n").replace(from, to),
        }
      : { ...document, source: document.source.replaceAll("\r\n", "\n") },
  );
  return workspaceWithDocuments(documents);
}

test("pinned golden passes every prompt and shared Python rule", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-packages",
    "prompt/secure-client-configuration",
    "prompt/retry-and-http-logging",
    "prompt/sync-service-operations",
    "prompt/async-service-operations",
    "prompt/streaming-upload-and-tags",
    "prompt/lease-protected-overwrite",
    "prompt/operation-timeouts",
    "prompt/sdk-error-handling",
    "prompt/demo-workflow",
  ]);
  assert.equal(
    dependencies,
    "azure-identity==1.25.3\nazure-storage-blob==12.30.1\n",
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, goldenWorkspace), true, rule);
  }
  for (const check of languageChecks) {
    assert.equal(evaluatePythonCheck(check, languageWorkspace), true, check);
  }
});

test("runtime dependency manifests accept standard active forms", () => {
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
        {
          dependencies: manifest,
          dependencyManifests: [{ content: manifest, filename }],
          documents: [{ path: "main.py", source: "print('app')\n" }],
        },
      ),
      true,
      filename,
    );
  }
});

test("prose, development-only, optional, and partial manifests fail", () => {
  const cases = [
    ["requirements.txt", "Install azure-identity and azure-storage-blob."],
    ["requirements-dev.txt", "azure-identity\nazure-storage-blob"],
    [
      "pyproject.toml",
      `[project.optional-dependencies]\ndev = ["azure-identity", "azure-storage-blob"]`,
    ],
    ["requirements.txt", "azure-identity==1.25.3"],
    ["requirements.txt", "azure-storage-blob==12.30.1"],
  ];
  for (const [filename, manifest] of cases) {
    assert.equal(
      evaluateRule(
        "prompt/sdk-packages",
        {
          dependencies: manifest,
          dependencyManifests: [{ content: manifest, filename }],
          documents: [{ path: "main.py", source: "print('app')\n" }],
        },
      ),
      false,
      `${filename}: ${manifest}`,
    );
  }
});

test("workspace discovery ignores tests, generated files, and skills", () => {
  const root = fileURLToPath(new URL("./.workspace-fixture", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "generated"), { recursive: true });
    mkdirSync(join(root, ".vally"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    for (const [path, source] of Object.entries(documents)) {
      writeFileSync(join(root, path), source);
    }
    writeFileSync(join(root, "tests", "test_decoy.py"), documents["main.py"]);
    writeFileSync(join(root, "generated", "decoy.py"), documents["main.py"]);
    writeFileSync(join(root, ".vally", "skill.py"), documents["main.py"]);

    const discovered = loadStorageBlobManagerWorkspace(root);
    assert.equal(discovered.topLevelPythonFiles.length, 4);
    assert.equal(discovered.documents.length, 4);
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, discovered), true, rule);
    }

    writeFileSync(join(root, "main.py"), "print('decoy')\n");
    const decoysOnly = loadStorageBlobManagerWorkspace(root);
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, decoysOnly), false, rule);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("entrypoint fails when no top-level generated Python file exists", () => {
  const root = fileURLToPath(new URL("./.no-top-level", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    writeFileSync(join(root, "src", "app.py"), documents["main.py"]);

    const result = spawnSync(
      "node",
      [checkScript, "prompt/secure-client-configuration"],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /No top-level generated application Python files were found\./,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("comments, strings, invalid syntax, and local fake clients cannot pass", () => {
  const fake = `
class DefaultAzureCredential:
    pass

class BlobServiceClient:
    def __init__(self, *args, **kwargs):
        pass

class BlobLeaseClient:
    def __init__(self, *args, **kwargs):
        pass

credential = DefaultAzureCredential()
client = BlobServiceClient("https://example.invalid", credential=credential)
lease = BlobLeaseClient(client)
`;
  for (const source of [
    "",
    "# BlobServiceClient upload_blob download_blob acquire_lease delete_blob\n",
    '"""DefaultAzureCredential BlobServiceClient BlobLeaseClient HttpResponseError"""\n',
    "this is not valid Python",
    fake,
  ]) {
    const workspace = {
      dependencies,
      dependencyManifests: [{ content: dependencies, filename: "requirements.txt" }],
      documents: [{ path: "main.py", source }],
    };
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, workspace), false, rule);
    }
  }
});

test("each missing core behavior fails its focused rule", () => {
  const cases = [
    [
      "prompt/secure-client-configuration",
      replaceDocument(
        "config.py",
        "account_url=settings.account_url,",
        'account_url="https://example.blob.core.windows.net",',
      ),
    ],
    [
      "prompt/retry-and-http-logging",
      replaceDocument("config.py", "logging_enable=True,", "logging_enable=False,"),
    ],
    [
      "prompt/sync-service-operations",
      replaceDocument(
        "main.py",
        "manager.delete(timeout=30)",
        "manager.list_blobs(timeout=30)",
      ),
    ],
    [
      "prompt/async-service-operations",
      replaceDocument(
        "main.py",
        "await manager.delete(timeout=30)",
        "await manager.list_blobs(timeout=30)",
      ),
    ],
    [
      "prompt/streaming-upload-and-tags",
      replaceDocument(
        "blob_manager.py",
        "with open(source_path, \"rb\") as stream:",
        "stream = Path(source_path).read_bytes()",
      ),
    ],
    [
      "prompt/lease-protected-overwrite",
      replaceDocument("blob_manager.py", "lease=lease,", ""),
    ],
    [
      "prompt/operation-timeouts",
      replaceDocument(
        "async_blob_manager.py",
        "            await self._blob_client.delete_blob(timeout=timeout)",
        "            await self._blob_client.delete_blob()",
      ),
    ],
    [
      "prompt/sdk-error-handling",
      replaceDocument(
        "async_blob_manager.py",
        "except (ResourceExistsError, ResourceModifiedError) as error:",
        "except ValueError as error:",
      ),
    ],
    [
      "prompt/demo-workflow",
      replaceDocument(
        "main.py",
        "run_sync_demo(settings)\n    asyncio.run(run_async_demo(settings))",
        "asyncio.run(run_async_demo(settings))\n    run_sync_demo(settings)",
      ),
    ],
  ];
  for (const [rule, workspace] of cases) {
    assert.equal(evaluateRule(rule, workspace), false, rule);
  }
});

test("demo workflow rejects reachable async interleaving before sync completion", () => {
  const workspace = replaceDocument(
    "main.py",
    "                )\n                print(\"Sync: listing blobs\")",
    "                )\n                asyncio.run(run_async_demo(settings))\n                print(\"Sync: listing blobs\")",
  );
  assert.equal(evaluateRule("prompt/sync-service-operations", workspace), true);
  assert.equal(evaluateRule("prompt/async-service-operations", workspace), true);
  assert.equal(evaluateRule("prompt/demo-workflow", workspace), false);
});

test("demo workflow accepts ordered helper and alias wrappers", () => {
  const workspace = replaceDocument(
    "main.py",
    `def main() -> None:
    settings = load_settings()
    write_sample_file(settings.source_path)
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))
`,
    `def run_demo_workflow(settings) -> None:
    sync_runner = run_sync_demo
    async_runner = run_async_demo
    sync_runner(settings)
    asyncio.run(async_runner(settings))


def main() -> None:
    settings = load_settings()
    write_sample_file(settings.source_path)
    run_demo_workflow(settings)
`,
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test("demo workflow rejects incompatible sync and async branches", () => {
  const workspace = replaceDocument(
    "main.py",
    `def main() -> None:
    settings = load_settings()
    write_sample_file(settings.source_path)
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))
`,
    `def main() -> None:
    settings = load_settings()
    write_sample_file(settings.source_path)
    if settings.container_name == "sync":
        run_sync_demo(settings)
    else:
        asyncio.run(run_async_demo(settings))
`,
  );
  assert.equal(evaluateRule("prompt/sync-service-operations", workspace), true);
  assert.equal(evaluateRule("prompt/async-service-operations", workspace), true);
  assert.equal(evaluateRule("prompt/demo-workflow", workspace), false);
});

test("set_blob_tags and blob_client.acquire_lease are accepted alternate SDK forms", () => {
  let workspace = replaceDocument(
    "blob_manager.py",
    "                    tags=tags,\n                    max_concurrency=4,\n                    timeout=timeout,\n                )",
    "                    max_concurrency=4,\n                    timeout=timeout,\n                )\n                self._blob_client.set_blob_tags(tags, timeout=timeout)",
  );
  workspace = replaceDocument(
    "blob_manager.py",
    "lease = BlobLeaseClient(self._blob_client)\n        try:\n            lease.acquire(lease_duration=30, timeout=timeout)",
    "try:\n            lease = self._blob_client.acquire_lease(lease_duration=30, timeout=timeout)",
    workspace.documents,
  );
  workspace = replaceDocument(
    "async_blob_manager.py",
    "                    tags=tags,\n                    max_concurrency=4,\n                    timeout=timeout,\n                )",
    "                    max_concurrency=4,\n                    timeout=timeout,\n                )\n                await self._blob_client.set_blob_tags(tags, timeout=timeout)",
    workspace.documents,
  );
  workspace = replaceDocument(
    "async_blob_manager.py",
    "lease = BlobLeaseClient(self._blob_client)\n        try:\n            await lease.acquire(lease_duration=30, timeout=timeout)",
    "try:\n            lease = await self._blob_client.acquire_lease(lease_duration=30, timeout=timeout)",
    workspace.documents,
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, workspace), true, rule);
  }
});

test("uncalled helpers, disconnected clients, and incompatible branches fail", () => {
  const uncalled = workspaceWithDocuments([
    { path: "main.py", source: documents["main.py"].replace("main()", "print('skip')") },
    ...goldenWorkspace.documents
      .filter((document) => document.path !== "main.py")
      .map((document) => ({ ...document })),
  ]);
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, uncalled), false, rule);
  }

  const disconnected = workspaceWithDocuments([
    {
      path: "main.py",
      source: `
from azure.identity import DefaultAzureCredential

from blob_manager import SyncBlobStorageManager
from config import create_sync_blob_service_client, load_settings


def main() -> None:
    settings = load_settings()
    with DefaultAzureCredential() as credential:
        primary_client = create_sync_blob_service_client(settings, credential)
        secondary_client = create_sync_blob_service_client(settings, credential)
        try:
            first = SyncBlobStorageManager(
                primary_client,
                settings.container_name,
                settings.blob_name,
            )
            second = SyncBlobStorageManager(
                secondary_client,
                settings.container_name,
                settings.blob_name,
            )
            first.ensure_container(timeout=30)
            first.upload(
                settings.source_path,
                metadata={"uploaded-by": "sync-manager"},
                tags={"category": "sample"},
                timeout=30,
            )
            first.list_blobs(timeout=30)
            first.download(settings.sync_download_path, timeout=30)
            second.overwrite_with_lease(settings.source_path, timeout=30)
            second.delete(timeout=30)
        finally:
            primary_client.close()
            secondary_client.close()


if __name__ == "__main__":
    main()
`,
    },
    ...goldenWorkspace.documents
      .filter((document) => document.path !== "main.py")
      .map((document) => ({ ...document })),
  ]);
  assert.equal(
    evaluateRule("prompt/sync-service-operations", disconnected),
    false,
  );

  const splitBranches = workspaceWithDocuments([
    {
      path: "main.py",
      source: `
from azure.identity import DefaultAzureCredential
from config import create_sync_blob_service_client, load_settings
from blob_manager import SyncBlobStorageManager

def main():
    settings = load_settings()
    with DefaultAzureCredential() as credential:
        with create_sync_blob_service_client(settings, credential) as service_client:
            manager = SyncBlobStorageManager(
                service_client,
                settings.container_name,
                settings.blob_name,
            )
            if settings.container_name:
                manager.upload(settings.source_path, tags={"a": "b"}, timeout=30)
                manager.list_blobs(timeout=30)
            else:
                manager.download(settings.sync_download_path, timeout=30)
                manager.overwrite_with_lease(settings.source_path, timeout=30)
                manager.delete(timeout=30)

if __name__ == "__main__":
    main()
`,
    },
    ...goldenWorkspace.documents
      .filter((document) => document.path !== "main.py")
      .map((document) => ({ ...document })),
  ]);
  assert.equal(
    evaluateRule("prompt/sync-service-operations", splitBranches),
    false,
  );
});

test("a local azure.storage.blob module cannot impersonate the SDK", () => {
  const workspace = workspaceWithDocuments([
    { path: "azure/storage/blob.py", source: "" },
    ...goldenWorkspace.documents.map((document) => ({ ...document })),
  ]);
  assert.equal(
    evaluateRule("prompt/secure-client-configuration", workspace),
    false,
  );
});
