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
  loadEncryptedUploaderWorkspace,
  ruleNames,
} from "./tools/encrypted-uploader-rules.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const checkScript = fileURLToPath(
  new URL("./tools/check-encrypted-uploader-python.mjs", import.meta.url),
);
const golden = loadEncryptedUploaderWorkspace(goldenPath);
const dependencies = golden.dependencies.replaceAll("\r\n", "\n");
const sourceRules = ruleNames().filter((rule) => rule !== "prompt/sdk-packages");
const sharedRules = [
  "language/correct-imports",
  "language/default-azure-credential",
  "language/client-lifecycle",
  "language/async-client",
  "language/exception-handling",
];

function assertSourceRulesFail(candidate, label) {
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, candidate), false, `${label}: ${rule}`);
  }
}

function workspace(documents, manifest = dependencies, filename = "requirements.txt") {
  return {
    dependencies: manifest,
    dependencyManifests: [{ content: manifest, filename }],
    documents: documents.map((document) => ({ ...document })),
  };
}

function change(path, from, to, documents = golden.documents) {
  return workspace(documents.map((document) => (
    document.path === path
      ? { ...document, source: document.source.replaceAll("\r\n", "\n").replace(from, to) }
      : { ...document, source: document.source.replaceAll("\r\n", "\n") }
  )));
}

test("pinned golden passes every scenario and shared Python check", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/sdk-packages",
    "prompt/key-vault-envelope-operations",
    "prompt/local-aes-gcm-encryption",
    "prompt/encrypted-blob-metadata-round-trip",
    "prompt/credential-and-client-configuration",
    "prompt/sync-and-async-implementations",
    "prompt/sdk-error-handling",
    "prompt/ordered-demo-workflow",
  ]);
  assert.equal(
    dependencies,
    [
      "azure-identity==1.25.3",
      "azure-storage-blob==12.30.1",
      "azure-keyvault-keys==4.11.2",
      "cryptography==50.0.1",
      "",
    ].join("\n"),
  );
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, golden), true, rule);
  const python = loadPythonWorkspace(goldenPath);
  for (const rule of sharedRules) assert.equal(evaluatePythonCheck(rule, python), true, rule);
});

test("runtime package declarations accept active standard forms", () => {
  for (const [filename, manifest] of [
    ["requirements-prod.txt", "azure_identity>=1\nazure.storage.blob>=12\nazure-keyvault-keys>=4\ncryptography>=50"],
    ["pyproject.toml", `[project]\ndependencies = ["azure-identity>=1", "azure-storage-blob>=12", "azure-keyvault-keys>=4", "cryptography>=50"]`],
    ["pyproject.toml", `[tool.poetry.dependencies]\npython = "^3.11"\nazure-identity = "1.25.3"\nazure-storage-blob = "12.30.1"\nazure-keyvault-keys = "4.11.2"\ncryptography = "50.0.1"`],
    ["setup.py", `from setuptools import setup\nsetup(install_requires=["azure-identity", "azure-storage-blob", "azure-keyvault-keys", "cryptography"])`],
  ]) {
    assert.equal(
      evaluateRule("prompt/sdk-packages", workspace([{ path: "main.py", source: "print('app')\n" }], manifest, filename)),
      true,
      filename,
    );
  }
});

test("comments, strings, syntax errors, fake SDKs, and inactive manifests fail", () => {
  for (const source of [
    "",
    "# CryptographyClient AESGCM wrap_key unwrap_key upload_blob\n",
    '"""DefaultAzureCredential and AESGCM are mentioned only as prose."""\n',
    "this is invalid Python",
    `
class CryptographyClient:
    def wrap_key(self, *args): pass
    def unwrap_key(self, *args): pass
class AESGCM:
    def encrypt(self, *args): pass
    def decrypt(self, *args): pass
`,
  ]) {
    for (const rule of sourceRules) {
      assert.equal(evaluateRule(rule, workspace([{ path: "main.py", source }])), false, rule);
    }
  }
  for (const manifest of [
    "Install azure-identity, azure-storage-blob, azure-keyvault-keys, and cryptography.",
    "azure-identity\nazure-storage-blob\nazure-keyvault-keys",
  ]) {
    assert.equal(
      evaluateRule("prompt/sdk-packages", workspace([{ path: "main.py", source: "print('app')" }], manifest)),
      false,
    );
  }
  const shadowed = workspace([
    { path: "azure/keyvault/keys/crypto.py", source: "" },
    ...golden.documents,
  ]);
  for (const rule of sourceRules) assert.equal(evaluateRule(rule, shadowed), false, rule);
});

test("each required cryptographic and storage behavior has a focused negative", () => {
  const noDek = change(
    "async_key_manager.py",
    "secrets.token_bytes(32)",
    "secrets.token_bytes(31)",
    change(
      "key_manager.py",
      "secrets.token_bytes(32)",
      "secrets.token_bytes(31)",
    ).documents,
  );
  const noKeyNotFoundHandling = workspace(golden.documents.map((document) => (
    document.path === "key_manager.py"
      ? {
          ...document,
          source: document.source.replaceAll(
            "ResourceNotFoundError",
            "ValueError",
          ),
        }
      : document
  )));
  const cases = [
    ["prompt/key-vault-envelope-operations", noDek],
    ["prompt/local-aes-gcm-encryption", "encrypted_blob_manager.py", "secrets.token_bytes(12)", "secrets.token_bytes(11)"],
    ["prompt/encrypted-blob-metadata-round-trip", "encrypted_blob_manager.py", '"key_id": self.key_id,', '"key_id_missing": self.key_id,'],
    ["prompt/encrypted-blob-metadata-round-trip", "encrypted_blob_manager.py", "metadata=metadata.as_blob_metadata(),", ""],
    ["prompt/credential-and-client-configuration", "config.py", "credential=credential),", "credential=object()),"],
    ["prompt/sync-and-async-implementations", "async_encrypted_blob_manager.py", "async def upload", "def upload"],
    ["prompt/sdk-error-handling", noKeyNotFoundHandling],
    ["prompt/ordered-demo-workflow", "main.py", "run_sync_demo(settings)\n    asyncio.run(run_async_demo(settings))", "asyncio.run(run_async_demo(settings))\n    run_sync_demo(settings)"],
  ];
  for (const [rule, path, from, to] of cases) {
    const candidate = path?.documents ? path : change(path, from, to);
    assert.equal(evaluateRule(rule, candidate), false, rule);
  }
});

test("forbidden SecretClient, direct vault crypto, non-GCM modes, and raw DEK persistence fail", () => {
  const cases = [
    [
      "SecretClient",
      "prompt/key-vault-envelope-operations",
      change("key_manager.py", "from azure.keyvault.keys.crypto import", "from azure.keyvault.secrets import SecretClient\nfrom azure.keyvault.keys.crypto import"),
    ],
    [
      "direct vault crypto",
      "prompt/key-vault-envelope-operations",
      change("key_manager.py", "return self._crypto_client.wrap_key(", "return self._crypto_client.encrypt("),
    ],
    [
      "CBC",
      "prompt/local-aes-gcm-encryption",
      change("encrypted_blob_manager.py", "from cryptography.hazmat.primitives.ciphers.aead import AESGCM", "from cryptography.hazmat.primitives.ciphers import modes\nfrom cryptography.hazmat.primitives.ciphers.aead import AESGCM\nmode = modes.CBC"),
    ],
    [
      "raw DEK persistence",
      "prompt/encrypted-blob-metadata-round-trip",
      change("encrypted_blob_manager.py", "wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)", "open('raw-dek.bin', 'wb').write(dek)\n        wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)"),
    ],
  ];
  for (const [label, rule, candidate] of cases) {
    assert.equal(evaluateRule(rule, candidate), false, label);
  }
});

test("unreachable helpers and empty generated roots cannot satisfy application behavior", () => {
  const uncalled = change("main.py", 'if __name__ == "__main__":\n    main()', 'if __name__ == "__main__":\n    print("skip")');
  for (const rule of sourceRules) assert.equal(evaluateRule(rule, uncalled), false, rule);

  const afterReturn = change(
    "encrypted_blob_manager.py",
    "def upload(self, plaintext: bytes) -> EncryptionMetadata:\n",
    "def upload(self, plaintext: bytes) -> EncryptionMetadata:\n        return EncryptionMetadata('', '', '')\n",
  );
  for (const rule of sourceRules) assert.equal(evaluateRule(rule, afterReturn), false, rule);

  const falseBranch = change(
    "encrypted_blob_manager.py",
    `        dek = self._key_manager.generate_data_encryption_key()
        nonce = secrets.token_bytes(12)
        ciphertext = AESGCM(dek).encrypt(nonce, plaintext, None)
        wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)
`,
    `        if False:
            dek = self._key_manager.generate_data_encryption_key()
            nonce = secrets.token_bytes(12)
            ciphertext = AESGCM(dek).encrypt(nonce, plaintext, None)
            wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)
`,
  );
  assert.equal(
    evaluateRule("prompt/encrypted-blob-metadata-round-trip", falseBranch),
    false,
  );

  const root = fileURLToPath(new URL("./.no-top-level", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "requirements.txt"), dependencies);
    writeFileSync(join(root, "src", "main.py"), "print('decoy')\n");
    const result = spawnSync("node", [checkScript, "prompt/key-vault-envelope-operations"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No top-level generated application Python files were found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("constant bypasses and path-incompatible upload decoys fail source criteria", () => {
  const constantBypass = change(
    "encrypted_blob_manager.py",
    "def upload(self, plaintext: bytes) -> EncryptionMetadata:\n",
    `def upload(self, plaintext: bytes) -> EncryptionMetadata:
        if 1 == 1:
            return EncryptionMetadata("", "", "")
`,
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, constantBypass), false, rule);
  }

  const disconnectedDecoy = change(
    "main.py",
    "    run_sync_demo(settings)\n    asyncio.run(run_async_demo(settings))",
    `    print("Skipping the encryption workflow")


def disconnected_demo(settings) -> None:
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))`,
  );
  for (const rule of sourceRules) {
    assert.equal(evaluateRule(rule, disconnectedDecoy), false, rule);
  }

  const pathIncompatible = change(
    "encrypted_blob_manager.py",
    "        ciphertext = AESGCM(dek).encrypt(nonce, plaintext, None)\n",
    `        if plaintext:
            ciphertext = AESGCM(dek).encrypt(nonce, plaintext, None)
        else:
            ciphertext = plaintext
`,
  );
  assert.equal(
    evaluateRule("prompt/local-aes-gcm-encryption", pathIncompatible),
    false,
  );
  assert.equal(
    evaluateRule("prompt/encrypted-blob-metadata-round-trip", pathIncompatible),
    false,
  );

  const plaintextUpload = change(
    "encrypted_blob_manager.py",
    "                ciphertext,\n",
    "                plaintext,\n",
  );
  assert.equal(
    evaluateRule("prompt/encrypted-blob-metadata-round-trip", plaintextUpload),
    false,
  );

  const metadataBypass = change(
    "encrypted_blob_manager.py",
    "    def as_blob_metadata(self) -> dict[str, str]:\n",
    `    def as_blob_metadata(self) -> dict[str, str]:
        if True:
            return {}
`,
  );
  assert.equal(
    evaluateRule("prompt/encrypted-blob-metadata-round-trip", metadataBypass),
    false,
  );

  const pathDependentSerializerBypass = change(
    "encrypted_blob_manager.py",
    `    def as_blob_metadata(self) -> dict[str, str]:
        return {
            "wrapped_dek": self.wrapped_dek,
            "nonce": self.nonce,
            "key_id": self.key_id,
        }`,
    `    def as_blob_metadata(self) -> dict[str, str]:
        if self.key_id:
            return {
                "wrapped_dek": self.wrapped_dek,
                "nonce": self.nonce,
                "key_id": self.key_id,
            }
        return {}`,
  );
  assert.equal(
    evaluateRule(
      "prompt/encrypted-blob-metadata-round-trip",
      pathDependentSerializerBypass,
    ),
    false,
  );
});

test("a single reachable trace must execute sync before async", () => {
  const mutuallyExclusive = change(
    "main.py",
    `    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))`,
    `    if settings.container_name:
        run_sync_demo(settings)
    else:
        asyncio.run(run_async_demo(settings))`,
  );
  const constantExclusive = change(
    "main.py",
    `    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))`,
    `    if True:
        run_sync_demo(settings)
    else:
        asyncio.run(run_async_demo(settings))`,
  );

  assertSourceRulesFail(mutuallyExclusive, "mutually exclusive workflows");
  assertSourceRulesFail(constantExclusive, "constant mutually exclusive workflow");
});

test("fake or fabricated round-trip components cannot satisfy real SDK provenance", () => {
  const withFakeBlobClass = change(
    "encrypted_blob_manager.py",
    "class BlobEncryptionError(Exception):",
    `class FakeBlobClient:
    def upload_blob(self, data, **kwargs):
        return None

    def get_blob_properties(self):
        return {"metadata": {}}

    def download_blob(self):
        return self

    def readall(self):
        return b"fabricated ciphertext"


class BlobEncryptionError(Exception):`,
  );
  const fakeBlob = change(
    "encrypted_blob_manager.py",
    `        self._blob_client = service_client.get_blob_client(
            container=container_name,
            blob=blob_name,
        )`,
    "        self._blob_client = FakeBlobClient()",
    withFakeBlobClass.documents,
  );
  const fabricatedKeyID = change(
    "key_manager.py",
    "return self._crypto_client.key_id",
    'return "https://example.invalid/keys/fabricated"',
  );

  assertSourceRulesFail(fakeBlob, "fake Blob client");
  assertSourceRulesFail(fabricatedKeyID, "fabricated key ID metadata");
});

test("demo output must carry round-trip values rather than presentation constants", () => {
  const constantOutput = change(
    "main.py",
    `    print(f"{label} vault key ID: {metadata.key_id}")
    print(f"{label} wrapped DEK: {metadata.wrapped_dek}")
    print(f"{label} decrypted output: {plaintext.decode('utf-8')}")`,
    `    print(f"{label} vault key ID: https://example.invalid/keys/constant")
    print(f"{label} wrapped DEK: Y29uc3RhbnQ=")
    print(f"{label} decrypted output: constant")`,
  );

  for (const rule of sourceRules) {
    assert.equal(
      evaluateRule(rule, constantOutput),
      rule !== "prompt/ordered-demo-workflow",
      rule,
    );
  }
});

test("all three demonstrated values must be reachable on one output path", () => {
  const withEnvironment = change(
    "main.py",
    "import asyncio\n",
    "import asyncio\nimport os\n",
  );
  const splitOutput = change(
    "main.py",
    `    print(f"{label} vault key ID: {metadata.key_id}")
    print(f"{label} wrapped DEK: {metadata.wrapped_dek}")
    print(f"{label} decrypted output: {plaintext.decode('utf-8')}")`,
    `    if os.environ.get("PRINT_KEY_ID"):
        print(f"{label} vault key ID: {metadata.key_id}")
    else:
        print(f"{label} wrapped DEK: {metadata.wrapped_dek}")
    print(f"{label} decrypted output: {plaintext.decode('utf-8')}")`,
    withEnvironment.documents,
  );
  const crossModeOutput = change(
    "main.py",
    `    print(f"{label} vault key ID: {metadata.key_id}")
    print(f"{label} wrapped DEK: {metadata.wrapped_dek}")
    print(f"{label} decrypted output: {plaintext.decode('utf-8')}")`,
    `    if label == "Sync":
        print(f"{label} wrapped DEK: {metadata.wrapped_dek}")
        print(f"{label} decrypted output: {plaintext.decode('utf-8')}")
    else:
        print(f"{label} vault key ID: {metadata.key_id}")
        print(f"{label} wrapped DEK: {metadata.wrapped_dek}")
        print(f"{label} decrypted output: {plaintext.decode('utf-8')}")`,
  );

  for (const candidate of [splitOutput, crossModeOutput]) {
    for (const rule of sourceRules) {
      assert.equal(
        evaluateRule(rule, candidate),
        rule !== "prompt/ordered-demo-workflow",
        rule,
      );
    }
  }
});

test("RSA-OAEP aliases, keyword arguments, and SDK constructor aliases pass", () => {
  const alternate = workspace(golden.documents.map((document) => {
    let source = document.source.replaceAll("\r\n", "\n");
    if (document.path === "key_manager.py") {
      source = source
        .replace(
          "class KeyVaultOperationError",
          "RSA_OAEP = KeyWrapAlgorithm.rsa_oaep\n\n\nclass KeyVaultOperationError",
        )
        .replace(
          "            return self._crypto_client.wrap_key(\n",
          "            algorithm = RSA_OAEP\n            return self._crypto_client.wrap_key(\n",
        )
        .replace(
          "                KeyWrapAlgorithm.rsa_oaep,\n                dek,\n",
          "                algorithm=algorithm,\n                key=dek,\n",
        )
        .replace(
          "            return self._crypto_client.unwrap_key(\n",
          "            algorithm = RSA_OAEP\n            return self._crypto_client.unwrap_key(\n",
        )
        .replace(
          "                KeyWrapAlgorithm.rsa_oaep,\n                wrapped_dek,\n",
          "                algorithm=algorithm,\n                key=wrapped_dek,\n",
        );
    }
    if (document.path === "async_key_manager.py") {
      source = source
        .replace(
          "class AsyncKeyManager",
          "RSA_OAEP = KeyWrapAlgorithm.rsa_oaep\n\n\nclass AsyncKeyManager",
        )
        .replace(
          "            result = await self._crypto_client.wrap_key(\n",
          "            algorithm = RSA_OAEP\n            result = await self._crypto_client.wrap_key(\n",
        )
        .replace(
          "                KeyWrapAlgorithm.rsa_oaep,\n                dek,\n",
          "                algorithm=algorithm,\n                key=dek,\n",
        )
        .replace(
          "            result = await self._crypto_client.unwrap_key(\n",
          "            algorithm = RSA_OAEP\n            result = await self._crypto_client.unwrap_key(\n",
        )
        .replace(
          "                KeyWrapAlgorithm.rsa_oaep,\n                wrapped_dek,\n",
          "                algorithm=algorithm,\n                key=wrapped_dek,\n",
        );
    }
    if (document.path === "config.py") {
      source = source
        .replaceAll("BlobServiceClient", "StorageClient")
        .replaceAll("CryptographyClient", "KeyCryptoClient")
        .replace(
          "from azure.keyvault.keys.crypto import KeyCryptoClient",
          "from azure.keyvault.keys.crypto import CryptographyClient as KeyCryptoClient",
        )
        .replace(
          "from azure.keyvault.keys.crypto.aio import KeyCryptoClient as AsyncKeyCryptoClient",
          "from azure.keyvault.keys.crypto.aio import CryptographyClient as AsyncKeyCryptoClient",
        )
        .replace(
          "from azure.storage.blob import StorageClient",
          "from azure.storage.blob import BlobServiceClient as StorageClient",
        )
        .replace(
          "from azure.storage.blob.aio import StorageClient as AsyncStorageClient",
          "from azure.storage.blob.aio import BlobServiceClient as AsyncStorageClient",
        );
    }
    return { ...document, source };
  }));
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, alternate), true, rule);
});

test("semantic provenance rejects raw DEK helpers, persistence, and disconnected credentials", () => {
  const rawWrappedDek = change(
    "key_manager.py",
    "            ).encrypted_key",
    "            )\n            return dek",
  );
  const rawUnwrappedDek = change(
    "key_manager.py",
    "            ).key",
    "            )\n            return wrapped_dek",
  );
  const discardedUnwrappedDek = change(
    "key_manager.py",
    "            ).key",
    "            )\n            return secrets.token_bytes(32)",
  );
  const finallyReturnsRawDek = change(
    "key_manager.py",
    `            raise KeyVaultOperationError("Key Vault could not wrap the DEK") from error

    def unwrap_data_encryption_key`,
    `            raise KeyVaultOperationError("Key Vault could not wrap the DEK") from error
        finally:
            return dek

    def unwrap_data_encryption_key`,
  );
  const unwrapsNonMetadata = change(
    "encrypted_blob_manager.py",
    'wrapped_dek = base64.b64decode(metadata["wrapped_dek"], validate=True)',
    "wrapped_dek = self._key_manager.wrap_data_encryption_key(secrets.token_bytes(32))",
  );
  const rawDekWriteAlias = change(
    "encrypted_blob_manager.py",
    "        wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)",
    `        raw_key = dek
        open("raw-key.bin", "wb").write(raw_key)
        wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)`,
  );
  const rawDekMetadata = change(
    "encrypted_blob_manager.py",
    "wrapped_dek=base64.b64encode(wrapped_dek)",
    "wrapped_dek=base64.b64encode(dek)",
  );
  const sharedObjectCredential = change(
    "config.py",
    "credential=credential",
    "credential=SHARED_CREDENTIAL",
    change(
      "config.py",
      "from __future__ import annotations\n",
      "from __future__ import annotations\n\nSHARED_CREDENTIAL = object()\n",
    ).documents,
  );

  for (const candidate of [
    rawWrappedDek,
    rawUnwrappedDek,
    discardedUnwrappedDek,
    finallyReturnsRawDek,
    unwrapsNonMetadata,
  ]) {
    assert.equal(
      evaluateRule("prompt/key-vault-envelope-operations", candidate),
      false,
    );
    assert.equal(
      evaluateRule("prompt/encrypted-blob-metadata-round-trip", candidate),
      false,
    );
  }
  for (const candidate of [rawDekWriteAlias, rawDekMetadata]) {
    assert.equal(evaluateRule("prompt/key-vault-envelope-operations", candidate), false);
    assert.equal(
      evaluateRule("prompt/encrypted-blob-metadata-round-trip", candidate),
      false,
    );
  }
  assert.equal(
    evaluateRule("prompt/credential-and-client-configuration", sharedObjectCredential),
    false,
  );
});

test("exact DEK and downloaded ciphertext lineage rejects transformations", () => {
  const transformWrapInput = (expression, addBase64Import = false) => workspace(
    golden.documents.map((document) => {
      let source = document.source.replaceAll("\r\n", "\n");
      if (document.path === "key_manager.py") {
        if (addBase64Import) source = source.replace("import secrets\n", "import base64\nimport secrets\n");
        source = source.replace(
          "                dek,\n            ).encrypted_key",
          `                ${expression},\n            ).encrypted_key`,
        );
      }
      if (document.path === "async_key_manager.py") {
        if (addBase64Import) source = source.replace("import secrets\n", "import base64\nimport secrets\n");
        source = source.replace(
          "                dek,\n            )\n            return result.encrypted_key",
          `                ${expression},\n            )\n            return result.encrypted_key`,
        );
      }
      return { ...document, source };
    }),
  );
  const mutateWrapInput = workspace(golden.documents.map((document) => {
    let source = document.source.replaceAll("\r\n", "\n");
    if (document.path === "key_manager.py") {
      source = source.replace(
        "    def wrap_data_encryption_key(self, dek: bytes) -> bytes:\n        try:",
        "    def wrap_data_encryption_key(self, dek: bytes) -> bytes:\n        dek[0:1] = b\"\\x00\"\n        try:",
      );
    }
    if (document.path === "async_key_manager.py") {
      source = source.replace(
        "    async def wrap_data_encryption_key(self, dek: bytes) -> bytes:\n        try:",
        "    async def wrap_data_encryption_key(self, dek: bytes) -> bytes:\n        dek[0:1] = b\"\\x00\"\n        try:",
      );
    }
    return { ...document, source };
  }));

  const transformDownloadedCiphertext = (expression) => workspace(
    golden.documents.map((document) => {
      let source = document.source.replaceAll("\r\n", "\n");
      if (document.path === "encrypted_blob_manager.py") {
        source = source.replace(
          "return AESGCM(dek).decrypt(nonce, ciphertext, None)",
          `return AESGCM(dek).decrypt(nonce, ${expression}, None)`,
        );
      }
      if (document.path === "async_encrypted_blob_manager.py") {
        source = source.replace(
          "return AESGCM(dek).decrypt(nonce, ciphertext, None)",
          `return AESGCM(dek).decrypt(nonce, ${expression}, None)`,
        );
      }
      return { ...document, source };
    }),
  );
  const mutateDownloadedCiphertext = workspace(golden.documents.map((document) => {
    let source = document.source.replaceAll("\r\n", "\n");
    if (document.path === "encrypted_blob_manager.py") {
      source = source.replace(
        "            ciphertext = self._blob_client.download_blob().readall()",
        "            ciphertext = self._blob_client.download_blob().readall()\n            ciphertext[0:1] = b\"\\x00\"",
      );
    }
    if (document.path === "async_encrypted_blob_manager.py") {
      source = source.replace(
        "            ciphertext = await (await self._blob_client.download_blob()).readall()",
        "            ciphertext = await (await self._blob_client.download_blob()).readall()\n            ciphertext[0:1] = b\"\\x00\"",
      );
    }
    return { ...document, source };
  }));

  const cases = [
    ["sliced DEK", transformWrapInput("dek[:-1]")],
    ["concatenated DEK", transformWrapInput('dek + b"\\x00"')],
    [
      "base64 round-tripped DEK",
      transformWrapInput("base64.b64decode(base64.b64encode(dek))", true),
    ],
    ["mutated DEK", mutateWrapInput],
    ["sliced downloaded ciphertext", transformDownloadedCiphertext("ciphertext[:-1]")],
    [
      "concatenated downloaded ciphertext",
      transformDownloadedCiphertext('ciphertext + b"\\x00"'),
    ],
    [
      "base64 round-tripped downloaded ciphertext",
      transformDownloadedCiphertext("base64.b64decode(base64.b64encode(ciphertext))"),
    ],
    ["mutated downloaded ciphertext", mutateDownloadedCiphertext],
  ];
  for (const [label, candidate] of cases) {
    assertSourceRulesFail(candidate, label);
  }
});

test("exact metadata, unwrap, IV, and key ID lineage rejects transformations", () => {
  const alter = (syncFrom, syncTo, asyncFrom = syncFrom, asyncTo = syncTo) => workspace(
    golden.documents.map((document) => {
      let source = document.source.replaceAll("\r\n", "\n");
      if (document.path === "encrypted_blob_manager.py") {
        source = source.replace(syncFrom, syncTo);
      }
      if (document.path === "async_encrypted_blob_manager.py") {
        source = source.replace(asyncFrom, asyncTo);
      }
      return { ...document, source };
    }),
  );

  const cases = [
    [
      "wrapped metadata before unwrap",
      alter(
        'wrapped_dek = base64.b64decode(metadata["wrapped_dek"], validate=True)',
        'wrapped_dek = bytes(base64.b64decode(metadata["wrapped_dek"], validate=True))',
      ),
    ],
    [
      "metadata IV before decrypt",
      alter(
        'nonce = base64.b64decode(metadata["nonce"], validate=True)',
        'nonce = bytes(base64.b64decode(metadata["nonce"], validate=True))',
      ),
    ],
    [
      "unwrapped DEK before decrypt",
      alter(
        "dek = self._key_manager.unwrap_data_encryption_key(wrapped_dek)",
        "dek = bytes(self._key_manager.unwrap_data_encryption_key(wrapped_dek))",
        "dek = await self._key_manager.unwrap_data_encryption_key(wrapped_dek)",
        "dek = bytes(await self._key_manager.unwrap_data_encryption_key(wrapped_dek))",
      ),
    ],
    [
      "vault key ID metadata",
      alter(
        "key_id=self._key_manager.key_id,",
        'key_id=self._key_manager.key_id.encode("utf-8").decode("utf-8"),',
      ),
    ],
  ];
  for (const [label, candidate] of cases) {
    assertSourceRulesFail(candidate, label);
  }
});

test("aliases and pass-through helpers retain exact encryption lineage", () => {
  const alternate = workspace(golden.documents.map((document) => {
    let source = document.source.replaceAll("\r\n", "\n");
    if (document.path === "key_manager.py") {
      source = source
        .replace(
          "class KeyVaultOperationError",
          "def pass_through(value):\n    return value\n\n\nclass KeyVaultOperationError",
        )
        .replace(
          "    def wrap_data_encryption_key(self, dek: bytes) -> bytes:\n        try:",
          "    def wrap_data_encryption_key(self, dek: bytes) -> bytes:\n        wrap_key_alias = dek\n        try:",
        )
        .replace(
          "                dek,\n            ).encrypted_key",
          "                pass_through(wrap_key_alias),\n            ).encrypted_key",
        );
    }
    if (document.path === "async_key_manager.py") {
      source = source
        .replace(
          "class AsyncKeyManager",
          "def pass_through(value):\n    return value\n\n\nclass AsyncKeyManager",
        )
        .replace(
          "    async def wrap_data_encryption_key(self, dek: bytes) -> bytes:\n        try:",
          "    async def wrap_data_encryption_key(self, dek: bytes) -> bytes:\n        wrap_key_alias = dek\n        try:",
        )
        .replace(
          "                dek,\n            )\n            return result.encrypted_key",
          "                pass_through(wrap_key_alias),\n            )\n            return result.encrypted_key",
        );
    }
    if (document.path === "encrypted_blob_manager.py") {
      source = source
        .replace(
          "class EncryptedBlobManager:",
          "def pass_through(value):\n    return value\n\n\nclass EncryptedBlobManager:",
        )
        .replace(
          `        wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)
        metadata = EncryptionMetadata(
            wrapped_dek=base64.b64encode(wrapped_dek).decode("ascii"),
            nonce=base64.b64encode(nonce).decode("ascii"),
            key_id=self._key_manager.key_id,
        )`,
          `        wrapped_dek = self._key_manager.wrap_data_encryption_key(dek)
        wrapped_dek_alias = wrapped_dek
        wrapped_metadata = base64.b64encode(wrapped_dek_alias).decode("ascii")
        nonce_metadata = base64.b64encode(nonce).decode("ascii")
        key_id_alias = self._key_manager.key_id
        metadata = EncryptionMetadata(
            wrapped_dek=pass_through(wrapped_metadata),
            nonce=pass_through(nonce_metadata),
            key_id=pass_through(key_id_alias),
        )`,
        )
        .replace(
          "            metadata = properties.metadata\n            ciphertext = self._blob_client.download_blob().readall()",
          "            metadata = properties.metadata\n            metadata_alias = pass_through(metadata)\n            ciphertext = self._blob_client.download_blob().readall()",
        )
        .replace(
          `            wrapped_dek = base64.b64decode(metadata["wrapped_dek"], validate=True)
            nonce = base64.b64decode(metadata["nonce"], validate=True)
            dek = self._key_manager.unwrap_data_encryption_key(wrapped_dek)
            return AESGCM(dek).decrypt(nonce, ciphertext, None)`,
          `            wrapped_dek = base64.b64decode(metadata_alias["wrapped_dek"], validate=True)
            nonce = base64.b64decode(metadata_alias["nonce"], validate=True)
            unwrapped_key = self._key_manager.unwrap_data_encryption_key(
                pass_through(wrapped_dek)
            )
            dek = pass_through(unwrapped_key)
            ciphertext_alias = ciphertext
            return AESGCM(dek).decrypt(
                pass_through(nonce),
                pass_through(ciphertext_alias),
                None,
            )`,
        );
    }
    if (document.path === "async_encrypted_blob_manager.py") {
      source = source
        .replace(
          "from encrypted_blob_manager import BlobEncryptionError, EncryptionMetadata",
          "from encrypted_blob_manager import BlobEncryptionError, EncryptionMetadata, pass_through",
        )
        .replace(
          `        wrapped_dek = await self._key_manager.wrap_data_encryption_key(dek)
        metadata = EncryptionMetadata(
            wrapped_dek=base64.b64encode(wrapped_dek).decode("ascii"),
            nonce=base64.b64encode(nonce).decode("ascii"),
            key_id=self._key_manager.key_id,
        )`,
          `        wrapped_dek = await self._key_manager.wrap_data_encryption_key(dek)
        wrapped_dek_alias = wrapped_dek
        wrapped_metadata = base64.b64encode(wrapped_dek_alias).decode("ascii")
        nonce_metadata = base64.b64encode(nonce).decode("ascii")
        key_id_alias = self._key_manager.key_id
        metadata = EncryptionMetadata(
            wrapped_dek=pass_through(wrapped_metadata),
            nonce=pass_through(nonce_metadata),
            key_id=pass_through(key_id_alias),
        )`,
        )
        .replace(
          "            metadata = properties.metadata\n            ciphertext = await (await self._blob_client.download_blob()).readall()",
          "            metadata = properties.metadata\n            metadata_alias = pass_through(metadata)\n            ciphertext = await (await self._blob_client.download_blob()).readall()",
        )
        .replace(
          `            wrapped_dek = base64.b64decode(metadata["wrapped_dek"], validate=True)
            nonce = base64.b64decode(metadata["nonce"], validate=True)
            dek = await self._key_manager.unwrap_data_encryption_key(wrapped_dek)
            return AESGCM(dek).decrypt(nonce, ciphertext, None)`,
          `            wrapped_dek = base64.b64decode(metadata_alias["wrapped_dek"], validate=True)
            nonce = base64.b64decode(metadata_alias["nonce"], validate=True)
            unwrapped_key = await self._key_manager.unwrap_data_encryption_key(
                pass_through(wrapped_dek)
            )
            dek = pass_through(unwrapped_key)
            ciphertext_alias = ciphertext
            return AESGCM(dek).decrypt(
                pass_through(nonce),
                pass_through(ciphertext_alias),
                None,
            )`,
        );
    }
    return { ...document, source };
  }));

  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, alternate), true, rule);
});

test("equivalent helper outputs and reachable credential factories pass", () => {
  const alternate = workspace(golden.documents.map((document) => {
    let source = document.source.replaceAll("\r\n", "\n");
    if (document.path === "key_manager.py") {
      source = source
        .replace(
          "class KeyVaultOperationError",
          `def wrapped_key_bytes(result):
    return result.encrypted_key


def unwrapped_key_bytes(result):
    return result.key


class KeyVaultOperationError`,
        )
        .replace(
          "            return self._crypto_client.wrap_key(\n",
          "            result = self._crypto_client.wrap_key(\n",
        )
        .replace(
          "            ).encrypted_key\n        except",
          "            )\n            return wrapped_key_bytes(result)\n        except",
        )
        .replace(
          "            return self._crypto_client.unwrap_key(\n",
          "            result = self._crypto_client.unwrap_key(\n",
        )
        .replace(
          "            ).key\n        except",
          "            )\n            return unwrapped_key_bytes(result)\n        except",
        );
    }
    if (document.path === "main.py") {
      source = source
        .replace(
          "def run_sync_demo(settings) -> None:\n",
          `def create_sync_credential() -> DefaultAzureCredential:
    return DefaultAzureCredential()


def run_sync_demo(settings) -> None:
`,
        )
        .replace(
          "with DefaultAzureCredential() as credential:",
          "with create_sync_credential() as credential:",
        )
        .replace(
          "async def run_async_demo(settings) -> None:\n",
          `def create_async_credential() -> AsyncDefaultAzureCredential:
    return AsyncDefaultAzureCredential()


async def run_async_demo(settings) -> None:
`,
        )
        .replace(
          "async with AsyncDefaultAzureCredential() as credential:",
          "async with create_async_credential() as credential:",
        );
    }
    if (document.path === "config.py") {
      source = source
        .replace(
          `def create_sync_clients(
    settings: Settings, credential: object
) -> tuple[BlobServiceClient, CryptographyClient]:
    return (
        BlobServiceClient(account_url=settings.account_url, credential=credential),
        CryptographyClient(key_id=settings.key_id, credential=credential),
    )`,
          `class SyncClientFactory:
    def __init__(self, credential: object) -> None:
        self.credential = credential

    def create(
        self, settings: Settings
    ) -> tuple[BlobServiceClient, CryptographyClient]:
        return (
            BlobServiceClient(account_url=settings.account_url, credential=self.credential),
            CryptographyClient(key_id=settings.key_id, credential=self.credential),
        )


def create_sync_clients(
    settings: Settings, credential: object
) -> tuple[BlobServiceClient, CryptographyClient]:
    return SyncClientFactory(credential).create(settings)`,
        )
        .replace(
          `def create_async_clients(
    settings: Settings, credential: AsyncDefaultAzureCredential
) -> tuple[AsyncBlobServiceClient, AsyncCryptographyClient]:
    return (
        AsyncBlobServiceClient(
            account_url=settings.account_url,
            credential=credential,
        ),
        AsyncCryptographyClient(key_id=settings.key_id, credential=credential),
    )`,
          `class AsyncClientFactory:
    def __init__(self, credential: AsyncDefaultAzureCredential) -> None:
        self.credential = credential

    def create(
        self, settings: Settings
    ) -> tuple[AsyncBlobServiceClient, AsyncCryptographyClient]:
        return (
            AsyncBlobServiceClient(
                account_url=settings.account_url,
                credential=self.credential,
            ),
            AsyncCryptographyClient(
                key_id=settings.key_id,
                credential=self.credential,
            ),
        )


def create_async_clients(
    settings: Settings, credential: AsyncDefaultAzureCredential
) -> tuple[AsyncBlobServiceClient, AsyncCryptographyClient]:
    return AsyncClientFactory(credential).create(settings)`,
        );
    }
    return { ...document, source };
  }));
  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, alternate), true, rule);
});

test("reachable helper, client alias, and serializer alternatives retain provenance", () => {
  const alternate = workspace(golden.documents.map((document) => {
    let source = document.source.replaceAll("\r\n", "\n");
    if (document.path === "encrypted_blob_manager.py") {
      source = source
        .replace(
          "class EncryptedBlobManager:",
          `def blob_metadata(metadata: EncryptionMetadata) -> dict[str, str]:
    return metadata.as_blob_metadata()


class EncryptedBlobManager:`,
        )
        .replace(
          "            self._blob_client.upload_blob(\n",
          "            blob = self._blob_client\n            blob.upload_blob(\n",
        )
        .replace(
          "metadata=metadata.as_blob_metadata(),",
          "metadata=blob_metadata(metadata),",
        )
        .replace(
          `            properties = self._blob_client.get_blob_properties()
            metadata = properties.metadata
            ciphertext = self._blob_client.download_blob().readall()`,
          `            stream = self._blob_client.download_blob()
            metadata = stream.properties.metadata
            ciphertext = stream.readall()`,
        );
    }
    if (document.path === "async_encrypted_blob_manager.py") {
      source = source
        .replace(
          "from encrypted_blob_manager import BlobEncryptionError, EncryptionMetadata",
          "from encrypted_blob_manager import BlobEncryptionError, EncryptionMetadata, blob_metadata",
        )
        .replace(
          "            await self._blob_client.upload_blob(\n",
          "            blob = self._blob_client\n            await blob.upload_blob(\n",
        )
        .replace(
          "metadata=metadata.as_blob_metadata(),",
          "metadata=blob_metadata(metadata),",
        )
        .replace(
          `            properties = await self._blob_client.get_blob_properties()
            metadata = properties.metadata
            ciphertext = await (await self._blob_client.download_blob()).readall()`,
          `            stream = await self._blob_client.download_blob()
            metadata = stream.properties.metadata
            ciphertext = await stream.readall()`,
        );
    }
    if (document.path === "main.py") {
      source = source
        .replace(
          "def main() -> None:\n",
          `def run_ordered_demos(settings) -> None:
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))


def main() -> None:
`,
        )
        .replace(
          "    run_sync_demo(settings)\n    asyncio.run(run_async_demo(settings))",
          "    run_ordered_demos(settings)",
        );
    }
    return { ...document, source };
  }));

  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, alternate), true, rule);
});

test("an async entry can run the synchronous client round trip first", () => {
  const alternate = change(
    "main.py",
    `def main() -> None:
    settings = load_settings()
    run_sync_demo(settings)
    asyncio.run(run_async_demo(settings))


if __name__ == "__main__":
    main()`,
    `async def main() -> None:
    settings = load_settings()
    run_sync_demo(settings)
    await run_async_demo(settings)


if __name__ == "__main__":
    asyncio.run(main())`,
  );

  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, alternate), true, rule);
});

test("a compact direct-SDK implementation remains a positive oracle", () => {
  const compact = workspace([{
    path: "app.py",
    source: `
import asyncio
import base64
import os
import secrets

from azure.core.exceptions import HttpResponseError, ResourceNotFoundError
from azure.identity import DefaultAzureCredential
from azure.identity.aio import DefaultAzureCredential as AsyncDefaultAzureCredential
from azure.keyvault.keys.crypto import CryptographyClient, KeyWrapAlgorithm
from azure.keyvault.keys.crypto.aio import CryptographyClient as AsyncCryptographyClient
from azure.storage.blob import BlobServiceClient
from azure.storage.blob.aio import BlobServiceClient as AsyncBlobServiceClient
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def sync_demo():
    credential = DefaultAzureCredential()
    blob = BlobServiceClient(
        account_url=os.environ["MY_STORAGE_ENDPOINT"],
        credential=credential,
    ).get_blob_client(container="encrypted", blob="sync.bin")
    crypto = CryptographyClient(
        key_id=os.environ["MY_KEY_IDENTIFIER"],
        credential=credential,
    )
    dek = secrets.token_bytes(nbytes=32)
    nonce = os.urandom(12)
    ciphertext = AESGCM(dek).encrypt(nonce, b"sync plaintext", None)
    try:
        wrapped = crypto.wrap_key(
            KeyWrapAlgorithm.rsa_oaep_256,
            dek,
        ).encrypted_key
    except (ResourceNotFoundError, HttpResponseError):
        raise
    metadata = {
        "wrapped_dek": base64.urlsafe_b64encode(wrapped).decode("ascii"),
        "nonce": base64.urlsafe_b64encode(nonce).decode("ascii"),
        "key_id": crypto.key_id,
    }
    try:
        blob.upload_blob(ciphertext, overwrite=True, metadata=metadata)
    except (ResourceNotFoundError, HttpResponseError):
        raise
    try:
        properties = blob.get_blob_properties()
        downloaded = blob.download_blob().readall()
    except (ResourceNotFoundError, HttpResponseError):
        raise
    try:
        unwrapped = crypto.unwrap_key(
            KeyWrapAlgorithm.rsa_oaep_256,
            base64.urlsafe_b64decode(properties.metadata["wrapped_dek"]),
        ).key
    except (ResourceNotFoundError, HttpResponseError):
        raise
    plaintext = AESGCM(unwrapped).decrypt(
        base64.urlsafe_b64decode(properties.metadata["nonce"]),
        downloaded,
        None,
    )
    print("sync vault key ID", metadata["key_id"])
    print("sync wrapped DEK", metadata["wrapped_dek"])
    print("sync decrypted output", plaintext)


async def async_demo():
    credential = AsyncDefaultAzureCredential()
    blob = AsyncBlobServiceClient(
        account_url=os.environ["MY_STORAGE_ENDPOINT"],
        credential=credential,
    ).get_blob_client(container="encrypted", blob="async.bin")
    crypto = AsyncCryptographyClient(
        key_id=os.environ["MY_KEY_IDENTIFIER"],
        credential=credential,
    )
    dek = secrets.token_bytes(size=32)
    nonce = secrets.token_bytes(12)
    ciphertext = AESGCM(dek).encrypt(nonce, b"async plaintext", None)
    try:
        wrapped = (
            await crypto.wrap_key(KeyWrapAlgorithm.rsa_oaep_256, dek)
        ).encrypted_key
    except (ResourceNotFoundError, HttpResponseError):
        raise
    metadata = {
        "wrapped_dek": base64.urlsafe_b64encode(wrapped).decode("ascii"),
        "nonce": base64.urlsafe_b64encode(nonce).decode("ascii"),
        "key_id": crypto.key_id,
    }
    try:
        await blob.upload_blob(ciphertext, overwrite=True, metadata=metadata)
    except (ResourceNotFoundError, HttpResponseError):
        raise
    try:
        stream = await blob.download_blob()
        downloaded = await stream.readall()
        properties = stream.properties
    except (ResourceNotFoundError, HttpResponseError):
        raise
    try:
        unwrapped = (
            await crypto.unwrap_key(
                KeyWrapAlgorithm.rsa_oaep_256,
                base64.urlsafe_b64decode(properties.metadata["wrapped_dek"]),
            )
        ).key
    except (ResourceNotFoundError, HttpResponseError):
        raise
    plaintext = AESGCM(unwrapped).decrypt(
        base64.urlsafe_b64decode(properties.metadata["nonce"]),
        downloaded,
        None,
    )
    print("async vault key ID", metadata["key_id"])
    print("async wrapped DEK", metadata["wrapped_dek"])
    print("async decrypted output", plaintext)


def main():
    sync_demo()
    asyncio.run(async_demo())


if __name__ == "__main__":
    main()
`,
  }]);

  for (const rule of ruleNames()) assert.equal(evaluateRule(rule, compact), true, rule);
});

test("workspace loading excludes tests, generated code, caches, and staged skills", () => {
  const root = fileURLToPath(new URL("./.workspace-fixture", import.meta.url));
  rmSync(root, { recursive: true, force: true });
  try {
    for (const directory of ["tests", "generated", ".vally", "__pycache__"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, "requirements.txt"), dependencies);
    for (const document of golden.documents) writeFileSync(join(root, document.path), document.source);
    writeFileSync(join(root, "tests", "test_decoy.py"), "not valid Python");
    writeFileSync(join(root, "generated", "decoy.py"), "not valid Python");
    writeFileSync(join(root, ".vally", "skill.py"), "not valid Python");
    const discovered = loadEncryptedUploaderWorkspace(root);
    assert.equal(discovered.documents.length, golden.documents.length);
    for (const rule of ruleNames()) assert.equal(evaluateRule(rule, discovered), true, rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
