import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  evaluateTypeScriptCheck,
  typeScriptCheckNames,
} from "../../languages/typescript/checks.mjs";
import {
  evaluateRule,
  ruleNames,
} from "./tools/encrypted-uploader-typescript-rules.mjs";
import {
  activeDependencies,
  loadSourceManifest,
  sourceDocuments,
} from "./tools/source-manifest.mjs";

const goldenPath = fileURLToPath(new URL("./golden", import.meta.url));
const golden = loadSourceManifest(goldenPath);
const baseline33374429826 = loadSourceManifest(
  fileURLToPath(
    new URL("./fixtures/baseline-33374429826", import.meta.url),
  ),
);
const baseline33441637671 = loadSourceManifest(
  fileURLToPath(
    new URL("./fixtures/baseline-33441637671", import.meta.url),
  ),
);

function withDocuments(documents, packageJson = golden.packageJson) {
  return { ...golden, documents, sourceFiles: documents.map(({ path }) => path), packageJson };
}

function withSource(source, packageJson = golden.packageJson) {
  return withDocuments([{ path: "src/main.ts", source }], packageJson);
}

function without(fragment) {
  return withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(fragment, ""),
    })),
  );
}

function rejectsConnectedRoundTrip(workspace, label = "") {
  assert.equal(
    evaluateRule("prompt/connected-round-trip", workspace),
    false,
    label || "prompt/connected-round-trip",
  );
}

function changeDocument(path, transform) {
  return withDocuments(
    golden.documents.map((document) =>
      document.path === path
        ? {
            ...document,
            source: transform(document.source.replaceAll("\r\n", "\n")),
          }
        : document,
    ),
  );
}

function changeDocuments(transforms) {
  return withDocuments(
    golden.documents.map((document) => {
      const transform = transforms[document.path];
      return transform
        ? {
            ...document,
            source: transform(document.source.replaceAll("\r\n", "\n")),
          }
        : document;
    }),
  );
}

function changeBaselineDocument(path, transform) {
  return withDocuments(
    baseline33374429826.documents.map((document) =>
      document.path === path
        ? {
            ...document,
            source: transform(document.source.replaceAll("\r\n", "\n")),
          }
        : document,
    ),
    baseline33374429826.packageJson,
  );
}

function changeCurrentBaselineDocument(path, transform) {
  return withDocuments(
    baseline33441637671.documents.map((document) =>
      document.path === path
        ? {
            ...document,
            source: transform(document.source.replaceAll("\r\n", "\n")),
          }
        : document,
    ),
    baseline33441637671.packageJson,
  );
}

test("reference passes every encrypted uploader and shared TypeScript rule", () => {
  assert.deepEqual(ruleNames(), [
    "prompt/packages",
    "prompt/key-vault-envelope-encryption",
    "prompt/encrypted-blob-metadata",
    "prompt/decrypt-path",
    "prompt/managed-identity-configuration",
    "prompt/rest-error-handling",
    "prompt/connected-round-trip",
  ]);

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, golden), true, rule);
  }
  for (const rule of typeScriptCheckNames()) {
    assert.equal(evaluateTypeScriptCheck(rule, golden), true, rule);
  }
});

test("baseline run 33374429826 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, baseline33374429826),
      true,
      check,
    );
  }
});

test("baseline run 33441637671 exact output passes every grader", () => {
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, baseline33441637671), true, rule);
  }
  for (const check of typeScriptCheckNames()) {
    assert.equal(
      evaluateTypeScriptCheck(check, baseline33441637671),
      true,
      check,
    );
  }
});

test("metadata parser preserves the same downloaded response lineage", () => {
  const mutations = [
    [
      "fabricated wrapped key",
      (source) => source.replace(
        "wrappedDataKey,\n    iv,",
        'wrappedDataKey: Buffer.from("fabricated"),\n    iv,',
      ),
    ],
    [
      "swapped IV",
      (source) => source.replace("    iv,\n    authTag", "    iv: authTag,\n    authTag"),
    ],
    [
      "modified authentication tag",
      (source) => source.replace(
        "decipher.setAuthTag(encryption.authTag);",
        "decipher.setAuthTag(Buffer.concat([encryption.authTag, Buffer.alloc(1)]));",
      ),
    ],
    [
      "hardcoded key ID",
      (source) => source.replace(
        "    keyId: metadata.keyid,",
        '    keyId: "https://vault/keys/fabricated",',
      ),
    ],
    [
      "different download metadata",
      (source) => source.replace(
        "metadata = response.metadata;",
        `const otherResponse = await this.containerClient
        .getBlockBlobClient("other")
        .download();
      metadata = otherResponse.metadata;`,
      ),
    ],
  ];
  for (const [label, transform] of mutations) {
    const workspace = changeCurrentBaselineDocument(
      "src/encryptedBlobClient.ts",
      transform,
    );
    assert.equal(evaluateRule("prompt/decrypt-path", workspace), false, label);
    assert.equal(
      evaluateRule("prompt/connected-round-trip", workspace),
      false,
      label,
    );
  }
});

test("typed RSA-OAEP-256 literal is accepted but invalid enum members are rejected", () => {
  assert.equal(
    evaluateRule("prompt/key-vault-envelope-encryption", baseline33441637671),
    true,
  );
  const invalid = changeCurrentBaselineDocument(
    "src/keyManagement.ts",
    (source) => source.replace(
      'const WRAP_ALGORITHM: KeyWrapAlgorithm = "RSA-OAEP-256";',
      "const WRAP_ALGORITHM = KnownKeyExportEncryptionAlgorithm.RSAOaep999;",
    ),
  );
  assert.equal(
    evaluateRule("prompt/key-vault-envelope-encryption", invalid),
    false,
  );
  assert.equal(evaluateRule("prompt/connected-round-trip", invalid), false);
});

test("baseline forms support injected KeyClient, combined wrap, download metadata, and managed identity", () => {
  for (const rule of [
    "prompt/key-vault-envelope-encryption",
    "prompt/encrypted-blob-metadata",
    "prompt/decrypt-path",
    "prompt/managed-identity-configuration",
    "prompt/connected-round-trip",
  ]) {
    assert.equal(evaluateRule(rule, baseline33374429826), true, rule);
  }
});

test("baseline forms retain credential, key, metadata, and result provenance", () => {
  const separateCredential = changeBaselineDocument("src/config.ts", (source) =>
    source.replace(
      "keyClient: new KeyClient(keyVaultUrl, credential)",
      "keyClient: new KeyClient(keyVaultUrl, new ManagedIdentityCredential())",
    )
  );
  assert.equal(
    evaluateRule("prompt/managed-identity-configuration", separateCredential),
    false,
  );
  assert.equal(
    evaluateRule("prompt/connected-round-trip", separateCredential),
    false,
  );

  const unprovenInjectedClient = changeBaselineDocument(
    "src/keyManagement.ts",
    (source) =>
      source.replace(
        "private readonly keyClient: KeyClient",
        "private readonly keyClient: UnknownKeyClient",
      ),
  );
  assert.equal(
    evaluateRule(
      "prompt/key-vault-envelope-encryption",
      unprovenInjectedClient,
    ),
    false,
  );

  const fabricatedGeneratedKey = changeBaselineDocument(
    "src/keyManagement.ts",
    (source) =>
      source.replace(
        /dataKey,\n(\s*)wrappedKey:/,
        "dataKey: Buffer.alloc(32),\n$1wrappedKey:",
      ),
  );
  assert.equal(
    evaluateRule(
      "prompt/key-vault-envelope-encryption",
      fabricatedGeneratedKey,
    ),
    false,
  );

  const fabricatedDownloadMetadata = changeBaselineDocument(
    "src/encryptedBlobStorage.ts",
    (source) =>
      source.replace(
        "metadata = response.metadata ?? {};",
        "metadata = fabricatedMetadata;",
      ),
  );
  assert.equal(
    evaluateRule("prompt/decrypt-path", fabricatedDownloadMetadata),
    false,
  );
});

test("error handling must cover both reachable Azure services", () => {
  const keyErrorsUnhandled = changeBaselineDocument(
    "src/keyManagement.ts",
    (source) => source.replaceAll("try {", "{"),
  );
  assert.equal(
    evaluateRule("prompt/rest-error-handling", keyErrorsUnhandled),
    false,
  );

  const blobErrorsUnhandled = changeBaselineDocument(
    "src/encryptedBlobStorage.ts",
    (source) => source.replaceAll("try {", "{"),
  );
  assert.equal(
    evaluateRule("prompt/rest-error-handling", blobErrorsUnhandled),
    false,
  );
});

test("criteria remain independent when the demo round trip is disconnected", () => {
  const disconnected = withDocuments(
    baseline33374429826.documents.map((document) =>
      document.path === "src/index.ts"
        ? {
            ...document,
            source: `async function main(): Promise<void> {
  console.info("configuration only");
}
await main();`,
          }
        : document,
    ),
    baseline33374429826.packageJson,
  );
  for (const rule of ruleNames().slice(0, -1)) {
    assert.equal(evaluateRule(rule, disconnected), true, rule);
  }
  rejectsConnectedRoundTrip(disconnected);
});

test("reference pins the approved SDK and TypeScript versions", () => {
  const dependencies = activeDependencies(golden.packageJson);
  const manifest = JSON.parse(golden.packageJson);
  assert.deepEqual(
    {
      identity: dependencies["@azure/identity"],
      storage: dependencies["@azure/storage-blob"],
      keys: dependencies["@azure/keyvault-keys"],
      typescript: manifest.devDependencies.typescript,
      node: manifest.devDependencies["@types/node"],
    },
    {
      identity: "4.13.2",
      storage: "12.33.0",
      keys: "4.10.2",
      typescript: "5.9.2",
      node: "26.2.0",
    },
  );
  assert.match(
    readFileSync(new URL("./golden/pnpm-lock.yaml", import.meta.url), "utf8"),
    /specifier:\s+4\.10\.2/,
  );
});

test("source manifest accepts the real golden and ignores test-only decoys", () => {
  assert.deepEqual(
    golden.sourceFiles,
    [
      "src/config.ts",
      "src/encryptedBlobManager.ts",
      "src/keyManager.ts",
      "src/main.ts",
    ],
  );
  const workspace = withDocuments([
    ...golden.documents,
    { path: "tests/fake.ts", source: "const fake = 'SecretClient';" },
  ]);
  assert.equal(sourceDocuments(workspace).length, golden.documents.length);
  assert.equal(evaluateRule("prompt/packages", workspace), true);
});

test("comments, strings, fake SDKs, and absent source cannot satisfy rules", () => {
  const fake = withSource(`
    // const key = new KeyClient("https://example", credential);
    const prose = 'randomBytes(32) createCipheriv("aes-256-gcm") wrapKey("RSA-OAEP")';
    async function main() { await app.uploadText(); await app.downloadText(); }
    main().catch(console.error);
  `);
  assert.equal(evaluateRule("prompt/key-vault-envelope-encryption", fake), false);
  assert.equal(evaluateRule("prompt/packages", fake), false);

  const fakeSdk = withSource(`
    import { randomBytes } from "node:crypto";
    class KeyClient {} class CryptographyClient {} class BlobServiceClient {}
    async function main() { await app.uploadText(); await app.downloadText(); }
    main().catch(console.error);
  `);
  assert.equal(evaluateRule("prompt/packages", fakeSdk), false);
  assert.equal(evaluateRule("prompt/key-vault-envelope-encryption", fakeSdk), false);

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, withDocuments([])), false, rule);
  }
});

test("secrets, direct vault encryption, weak modes, and raw DEK persistence fail", () => {
  const secretsManifest = JSON.parse(golden.packageJson);
  secretsManifest.dependencies["@azure/keyvault-secrets"] = "4.10.0";
  assert.equal(
    evaluateRule("prompt/packages", withDocuments(golden.documents, JSON.stringify(secretsManifest))),
    false,
  );
  assert.equal(
    evaluateRule("prompt/key-vault-envelope-encryption", without('"aes-256-gcm"')),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/key-vault-envelope-encryption",
      withDocuments(golden.documents.map((document) => ({
        ...document,
        source: document.source.replaceAll("createCipheriv", "createCipher"),
      }))),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/key-vault-envelope-encryption",
      withDocuments(golden.documents.map((document) => ({
        ...document,
        source: document.source.replace(
          'const result = await cryptographyClient.wrapKey("RSA-OAEP", dataEncryptionKey);',
          'const result = await cryptographyClient.encrypt("RSA-OAEP", dataEncryptionKey);',
        ),
      }))),
    ),
    false,
  );
  assert.equal(
    evaluateRule(
      "prompt/encrypted-blob-metadata",
      withDocuments(golden.documents.map((document) => ({
        ...document,
        source: document.source.replace(
          "wrappedDek: wrappedDek.toString",
          "dataKey: dataEncryptionKey,\n          wrappedDek: wrappedDek.toString",
        ),
      }))),
    ),
    false,
  );
});

test("metadata and authentication restoration are mandatory", () => {
  assert.equal(
    evaluateRule("prompt/encrypted-blob-metadata", without("authTag: authenticationTag.toString")),
    false,
  );
  assert.equal(
    evaluateRule("prompt/decrypt-path", without("decipher.setAuthTag")),
    false,
  );
});

test("service error handling does not require RestError", () => {
  assert.equal(
    evaluateRule("prompt/rest-error-handling", baseline33374429826),
    true,
  );
});

test("false branches and disconnected helpers do not count as an application", () => {
  const unreachable = withDocuments(
    golden.documents.map((document) =>
      document.path === "src/main.ts"
        ? {
            ...document,
            source: `async function main(): Promise<void> { if (false) { await uploader.uploadText("x", "x"); await uploader.downloadText("x"); } }\nmain().catch(console.error);`,
          }
        : document,
    ),
  );
  rejectsConnectedRoundTrip(unreachable);
});

test("constant-true early returns and unreachable operation decoys fail every behavioral rule", () => {
  const earlyReturn = withDocuments(
    golden.documents.map((document) =>
      document.path === "src/main.ts"
        ? {
            ...document,
            source: `
              async function main(): Promise<void> {
                if (true) {
                  return;
                }
                await uploader.uploadText("x", "x");
                await uploader.downloadText("x");
              }
              main().catch(console.error);
            `,
          }
        : document,
    ),
  );
  rejectsConnectedRoundTrip(earlyReturn);

  const disconnected = withDocuments(
    golden.documents.map((document) =>
      document.path === "src/main.ts"
        ? {
            ...document,
            source: `
              async function main(): Promise<void> {
                console.info("the uploader is configured");
              }
              main().catch(console.error);
            `,
          }
        : document,
    ),
  );
  rejectsConnectedRoundTrip(disconnected);
});

test("unreachable and path-incompatible cryptographic decoys cannot fill missing steps", () => {
  const missingMetadataRead = withDocuments([
    ...golden.documents.map((document) =>
      document.path === "src/encryptedBlobManager.ts"
        ? {
            ...document,
            source: document.source.replace(
              "const properties = await blobClient.getProperties();",
              "const properties = { metadata: undefined };",
            ),
          }
        : document,
    ),
    {
      path: "src/metadata-decoy.ts",
      source: `
        export async function metadataDecoy(blobClient: { getProperties(): Promise<unknown> }) {
          return blobClient.getProperties();
        }
      `,
    },
  ]);
  assert.equal(evaluateRule("prompt/decrypt-path", missingMetadataRead), false);
  assert.equal(evaluateRule("prompt/connected-round-trip", missingMetadataRead), false);

  const incompatibleTag = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "decipher.setAuthTag(Buffer.from(metadata.authTag, \"base64\"));",
        "decipher.setAuthTag(Buffer.from(\"not-the-blob-tag\", \"base64\"));",
      ),
    })),
  );
  assert.equal(evaluateRule("prompt/decrypt-path", incompatibleTag), false);
  assert.equal(evaluateRule("prompt/connected-round-trip", incompatibleTag), false);

  const falseWrap = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'const result = await cryptographyClient.wrapKey("RSA-OAEP", dataEncryptionKey);',
        'if (false) { const result = await cryptographyClient.wrapKey("RSA-OAEP", dataEncryptionKey); }',
      ),
    })),
  );
  assert.equal(evaluateRule("prompt/key-vault-envelope-encryption", falseWrap), false);
  assert.equal(evaluateRule("prompt/connected-round-trip", falseWrap), false);

  const disconnectedSdk = withDocuments(
    golden.documents.map((document) =>
      document.path === "src/keyManager.ts"
        ? {
            ...document,
            source: document.source
              .replace(
                "type TokenCredential = ConstructorParameters<typeof KeyClient>[1];",
                `type TokenCredential = ConstructorParameters<typeof KeyClient>[1];
                class UnrelatedCryptographyClient {
                  public async wrapKey(): Promise<{ result: Buffer }> {
                    return { result: Buffer.alloc(0) };
                  }
                }`,
              )
              .replace(
                "const cryptographyClient = new CryptographyClient(key.id, this.credential);",
                `const genuineCryptographyClient = new CryptographyClient(key.id, this.credential);
                const cryptographyClient = new UnrelatedCryptographyClient();`,
              ),
          }
        : document,
    ),
  );
  assert.equal(
    evaluateRule("prompt/key-vault-envelope-encryption", disconnectedSdk),
    false,
  );
});

test("aliases, constants, and connected construction helpers remain accepted", () => {
  const alternate = withDocuments(
    golden.documents.map((document) => {
      if (document.path === "src/keyManager.ts") {
        return {
          ...document,
          source: document.source
            .replace(
              'import { CryptographyClient, KeyClient } from "@azure/keyvault-keys";',
              'import { CryptographyClient as Crypto, KeyClient as Keys } from "@azure/keyvault-keys";',
            )
            .replaceAll("typeof KeyClient", "typeof Keys")
            .replaceAll("new KeyClient", "new Keys")
            .replaceAll("new CryptographyClient", "new Crypto")
            .replace(
              "this.keyClient = new Keys(vaultUrl, credential);",
              "this.keyClient = createKeyClient(vaultUrl, credential);",
            )
            .replaceAll("new Crypto(key.id, this.credential)", "createCryptographyClient(key.id, this.credential)")
            .replaceAll("new Crypto(keyId, this.credential)", "createCryptographyClient(keyId, this.credential)")
            .replaceAll('"RSA-OAEP"', "keyWrapAlgorithm")
            .replace(
              'type TokenCredential = ConstructorParameters<typeof Keys>[1];',
              `type TokenCredential = ConstructorParameters<typeof Keys>[1];
              const keyWrapAlgorithm = "RSA-OAEP";
              function createKeyClient(vaultUrl: string, credential: TokenCredential): Keys {
                return new Keys(vaultUrl, credential);
              }
              function createCryptographyClient(keyId: string, credential: TokenCredential): Crypto {
                return new Crypto(keyId, credential);
              }`,
            ),
        };
      }
      if (document.path === "src/config.ts") {
        return {
          ...document,
          source: document.source
            .replace(
              'import { DefaultAzureCredential } from "@azure/identity";',
              'import { DefaultAzureCredential as Credential } from "@azure/identity";',
            )
            .replace(
              "BlobServiceClient, type ContainerClient",
              "BlobServiceClient as BlobService, type ContainerClient",
            )
            .replace("new DefaultAzureCredential", "new Credential")
            .replace("new BlobServiceClient", "new BlobService")
            .replace(
              "function requiredEnvironment",
              `function createCredential(): Credential {
                return new Credential();
              }
              function createBlobService(endpoint: string, credential: Credential): BlobService {
                return new BlobService(endpoint, credential);
              }

              function requiredEnvironment`,
            )
            .replace("const credential = new Credential();", "const credential = createCredential();")
            .replace(
              "const blobService = new BlobService(storageEndpoint, credential);",
              "const blobService = createBlobService(storageEndpoint, credential);",
            ),
        };
      }
      if (document.path === "src/encryptedBlobManager.ts") {
        return {
          ...document,
          source: document.source
            .replaceAll("randomBytes(32)", "randomBytes(dataEncryptionKeyLength)")
            .replaceAll("randomBytes(12)", "randomBytes(initializationVectorLength)")
            .replaceAll('"aes-256-gcm"', "encryptionAlgorithm")
            .replace(
              'import { KeyManager } from "./keyManager.js";',
              `import { KeyManager } from "./keyManager.js";

              const encryptionAlgorithm = "aes-256-gcm";
              const dataEncryptionKeyLength = 32;
              const initializationVectorLength = 12;`,
            ),
        };
      }
      return document;
    }),
  );
  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("upload provenance rejects plaintext and fabricated wrapped-key or tag metadata", () => {
  const plaintextUpload = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "uploadData(ciphertext, {",
        "uploadData(Buffer.from(plaintext, \"utf8\"), {",
      ),
    })),
  );
  const fabricatedWrappedKey = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'wrappedDek: wrappedDek.toString("base64")',
        'wrappedDek: Buffer.from("fabricated", "utf8").toString("base64")',
      ),
    })),
  );
  const fabricatedTag = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'authTag: authenticationTag.toString("base64")',
        'authTag: Buffer.from("fabricated", "utf8").toString("base64")',
      ),
    })),
  );
  const fabricatedWrapResult = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "return { keyId: key.id, wrappedDek: Buffer.from(result.result) };",
        'return { keyId: key.id, wrappedDek: Buffer.from("fabricated", "utf8") };',
      ),
    })),
  );
  const augmentedWrappedKey = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'wrappedDek: wrappedDek.toString("base64")',
        'wrappedDek: Buffer.concat([wrappedDek, Buffer.from("fabricated")]).toString("base64")',
      ),
    })),
  );
  const augmentedInitializationVector = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'iv: initializationVector.toString("base64")',
        'iv: Buffer.concat([initializationVector, Buffer.from("fabricated")]).toString("base64")',
      ),
    })),
  );
  const augmentedAuthenticationTag = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'authTag: authenticationTag.toString("base64")',
        'authTag: Buffer.concat([authenticationTag, Buffer.from("fabricated")]).toString("base64")',
      ),
    })),
  );
  const augmentedCiphertext = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "uploadData(ciphertext, {",
        'uploadData(Buffer.concat([ciphertext, Buffer.from("fabricated")]), {',
      ),
    })),
  );
  const augmentedDataEncryptionKey = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "this.keyManager.wrapDataEncryptionKey(dataEncryptionKey)",
        'this.keyManager.wrapDataEncryptionKey(Buffer.concat([dataEncryptionKey, Buffer.from("fabricated")]))',
      ),
    })),
  );

  for (const workspace of [
    plaintextUpload,
    fabricatedWrappedKey,
    fabricatedTag,
    fabricatedWrapResult,
    augmentedWrappedKey,
    augmentedInitializationVector,
    augmentedAuthenticationTag,
    augmentedCiphertext,
    augmentedDataEncryptionKey,
  ]) {
    assert.equal(evaluateRule("prompt/key-vault-envelope-encryption", workspace), false);
    assert.equal(evaluateRule("prompt/encrypted-blob-metadata", workspace), false);
    assert.equal(evaluateRule("prompt/connected-round-trip", workspace), false);
  }
});

test("download provenance rejects unrelated metadata, unwrap output, ciphertext, and tags", () => {
  const unrelatedWrappedKey = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "        wrappedDek,",
        '        Buffer.from("unrelated", "base64"),',
      ),
    })),
  );
  const unrelatedUnwrapResult = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "        dataEncryptionKey,",
        "        randomBytes(32),",
      ),
    })),
  );
  const plaintextCiphertext = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "decipher.update(ciphertext)",
        'decipher.update(Buffer.from("plaintext", "utf8"))',
      ),
    })),
  );
  const fabricatedTag = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));',
        'decipher.setAuthTag(Buffer.from("fabricated", "utf8"));',
      ),
    })),
  );
  const fabricatedUnwrapResult = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "return Buffer.from(result.result);",
        "return Buffer.alloc(32);",
      ),
    })),
  );
  const decoratedDecryption = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");',
        'return `fabricated ${Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")}`;',
      ),
    })),
  );
  const augmentedWrappedKey = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "        wrappedDek,",
        '        Buffer.concat([wrappedDek, Buffer.from("fabricated")]),',
      ),
    })),
  );
  const augmentedInitializationVector = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'Buffer.from(metadata.iv, "base64"),',
        'Buffer.concat([Buffer.from(metadata.iv, "base64"), Buffer.from("fabricated")]),',
      ),
    })),
  );
  const augmentedAuthenticationTag = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));',
        'decipher.setAuthTag(Buffer.concat([Buffer.from(metadata.authTag, "base64"), Buffer.from("fabricated")]));',
      ),
    })),
  );
  const overwrittenAuthenticationTag = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        'decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));',
        `decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));
      decipher.setAuthTag(Buffer.from("fabricated", "utf8"));`,
      ),
    })),
  );
  const augmentedDownloadedCiphertext = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "decipher.update(ciphertext)",
        'decipher.update(Buffer.concat([ciphertext, Buffer.from("fabricated")]))',
      ),
    })),
  );
  const augmentedUnwrappedKey = withDocuments(
    golden.documents.map((document) => ({
      ...document,
      source: document.source.replace(
        "        dataEncryptionKey,",
        '        Buffer.concat([dataEncryptionKey, Buffer.from("fabricated")]),',
      ),
    })),
  );

  for (const [label, workspace] of [
    ["unrelated wrapped key", unrelatedWrappedKey],
    ["unrelated unwrapped key", unrelatedUnwrapResult],
    ["plaintext ciphertext", plaintextCiphertext],
    ["fabricated authentication tag", fabricatedTag],
    ["fabricated unwrap result", fabricatedUnwrapResult],
    ["decorated decrypted output", decoratedDecryption],
    ["augmented wrapped key", augmentedWrappedKey],
    ["augmented initialization vector", augmentedInitializationVector],
    ["augmented authentication tag", augmentedAuthenticationTag],
    ["overwritten authentication tag", overwrittenAuthenticationTag],
    ["augmented downloaded ciphertext", augmentedDownloadedCiphertext],
    ["augmented unwrapped data key", augmentedUnwrappedKey],
  ]) {
    assert.equal(evaluateRule("prompt/decrypt-path", workspace), false, label);
    assert.equal(evaluateRule("prompt/connected-round-trip", workspace), false, label);
  }
});

test("operations only in a constant-true else branch are unreachable", () => {
  const unreachableElse = withDocuments(
    golden.documents.map((document) =>
      document.path === "src/main.ts"
        ? {
            ...document,
            source: `
              async function main(): Promise<void> {
                if (true) {
                  console.info("upload and download are intentionally skipped");
                } else {
                  await uploader.uploadText("x", "x");
                  await uploader.downloadText("x");
                }
              }
              main().catch(console.error);
            `,
          }
        : document,
    ),
  );
  rejectsConnectedRoundTrip(unreachableElse);
});

test("whole-program blockers reject early exits, invalid order, fabricated IDs, and fake outputs", () => {
  const earlyReturn = changeDocument("src/main.ts", (source) =>
    source.replace(
      "  const { containerClient, keyManager } = createApplicationClients();",
      `  const skipDemo = true;
  if (skipDemo) return;
  const { containerClient, keyManager } = createApplicationClients();`,
    )
  );
  const downloadBeforeUpload = changeDocument("src/main.ts", (source) =>
    source.replace(
      `  const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");
  const decrypted = await uploader.downloadText(blobName);`,
      `  const decrypted = await uploader.downloadText(blobName);
  const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");`,
    )
  );
  const concurrentUploadAndDownload = changeDocument("src/main.ts", (source) =>
    source.replace(
      `  const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");
  const decrypted = await uploader.downloadText(blobName);`,
      `  const [upload, decrypted] = await Promise.all([
    uploader.uploadText(blobName, "Azure envelope encryption sample"),
    uploader.downloadText(blobName),
  ]);`,
    )
  );
  const unawaitedUpload = changeDocument("src/main.ts", (source) =>
    source.replace(
      `  const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");
  const decrypted = await uploader.downloadText(blobName);`,
      `  const uploadPromise = uploader.uploadText(blobName, "Azure envelope encryption sample");
  const decrypted = await uploader.downloadText(blobName);
  const upload = await uploadPromise;`,
    )
  );
  const mutuallyExclusive = changeDocument("src/main.ts", (source) =>
    source.replace(
      `  const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");
  const decrypted = await uploader.downloadText(blobName);`,
      `  if (process.env.UPLOAD_ONLY) {
    await uploader.uploadText(blobName, "Azure envelope encryption sample");
  } else {
    await uploader.downloadText(blobName);
  }`,
    )
  );
  const ternaryExclusive = changeDocument("src/main.ts", (source) =>
    source.replace(
      `  const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");
  const decrypted = await uploader.downloadText(blobName);`,
      `  const upload = process.env.UPLOAD_ONLY
    ? await uploader.uploadText(blobName, "Azure envelope encryption sample")
    : undefined;
  const decrypted = process.env.UPLOAD_ONLY
    ? undefined
    : await uploader.downloadText(blobName);`,
    )
  );
  const constantOutputs = changeDocument("src/main.ts", (source) =>
    source.replace(
      `  console.log(\`Vault key ID: \${upload.keyId}\`);
  console.log(\`Wrapped DEK (base64): \${upload.wrappedDek}\`);
  console.log(\`Decrypted output: \${decrypted}\`);`,
      `  console.log("Vault key ID: fabricated");
  console.log("Wrapped DEK (base64): fabricated");
  console.log("Decrypted output: fabricated");`,
    )
  );
  const overwrittenOutputs = changeDocument("src/main.ts", (source) =>
    source
      .replace(
        'const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");',
        'let upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");',
      )
      .replace(
        "const decrypted = await uploader.downloadText(blobName);",
        "let decrypted = await uploader.downloadText(blobName);",
      )
      .replace(
        "  console.log(`Vault key ID: ${upload.keyId}`);",
        `  upload = { keyId: "fabricated", wrappedDek: "fabricated" };
  decrypted = "fabricated";
  console.log(\`Vault key ID: \${upload.keyId}\`);`,
      )
  );
  const overwrittenOutputProperties = changeDocument("src/main.ts", (source) =>
      source
        .replace(
          "const decrypted = await uploader.downloadText(blobName);",
          "let decrypted = await uploader.downloadText(blobName);",
        )
        .replace(
          "  console.log(`Vault key ID: ${upload.keyId}`);",
          `  upload.keyId = "fabricated";
  upload.wrappedDek = "fabricated";
  decrypted = "fabricated";
  console.log(\`Vault key ID: \${upload.keyId}\`);`,
        )
  );
  const fabricatedKeyId = changeDocument("src/keyManager.ts", (source) =>
    source.replace(
      "return { keyId: key.id, wrappedDek: Buffer.from(result.result) };",
      'return { keyId: "fabricated-key-id", wrappedDek: Buffer.from(result.result) };',
    )
  );
  const decoratedKeyId = changeDocument("src/keyManager.ts", (source) =>
    source.replace(
      "return { keyId: key.id, wrappedDek: Buffer.from(result.result) };",
      "return { keyId: `${key.id}/fabricated`, wrappedDek: Buffer.from(result.result) };",
    )
  );
  const ignoredCryptoKeyId = changeDocument("src/keyManager.ts", (source) =>
    source
      .replace(
        "new CryptographyClient(key.id, this.credential)",
        'new CryptographyClient("https://example.vault.azure.net/keys/fabricated", this.credential)',
      )
      .replace(
        "new CryptographyClient(keyId, this.credential)",
        'new CryptographyClient("https://example.vault.azure.net/keys/fabricated", this.credential)',
      )
  );
  const decoratedCryptoKeyId = changeDocument("src/keyManager.ts", (source) =>
      source.replace(
        "new CryptographyClient(key.id, this.credential)",
        "new CryptographyClient(`${key.id}/fabricated`, this.credential)",
      )
  );
  const invalidKeyWrapAlgorithm = changeDocument("src/keyManager.ts", (source) =>
      source.replaceAll('"RSA-OAEP"', '"RSA-OAEP-999"')
  );
  const overwrittenVaultKeyId = changeDocument("src/keyManager.ts", (source) =>
      source.replace(
        "const cryptographyClient = new CryptographyClient(key.id, this.credential);",
        `key.id = "fabricated";
        const cryptographyClient = new CryptographyClient(key.id, this.credential);`,
      )
  );
  const decoratedStoredKeyId = changeDocument(
      "src/encryptedBlobManager.ts",
      (source) =>
        source.replace(
          "          keyId,\n        },",
          "          keyId: `${keyId}/fabricated`,\n        },",
        ),
  );
  const augmentedWrapResult = changeDocument("src/keyManager.ts", (source) =>
    source.replace(
        "return { keyId: key.id, wrappedDek: Buffer.from(result.result) };",
        `return {
          keyId: key.id,
          wrappedDek: Buffer.concat([Buffer.from(result.result), Buffer.from("fabricated")]),
        };`,
    )
  );
  const augmentedUnwrapResult = changeDocument("src/keyManager.ts", (source) =>
    source.replace(
        "return Buffer.from(result.result);",
        'return Buffer.concat([Buffer.from(result.result), Buffer.from("fabricated")]);',
    )
  );
  const overwrittenWrapResult = changeDocument("src/keyManager.ts", (source) =>
    source.replace(
        "return { keyId: key.id, wrappedDek: Buffer.from(result.result) };",
        `result.result = Buffer.from("fabricated");
        return { keyId: key.id, wrappedDek: Buffer.from(result.result) };`,
    )
  );
  const overwrittenUnwrapResult = changeDocument("src/keyManager.ts", (source) =>
    source.replace(
        "return Buffer.from(result.result);",
        `result.result = Buffer.from("fabricated");
        return Buffer.from(result.result);`,
    )
  );
  const fakeBlobClient = changeDocument("src/encryptedBlobManager.ts", (source) =>
    source.replace(
      "await this.containerClient.getBlockBlobClient(blobName).uploadData(ciphertext, {",
      `const fakeBlob = {
        uploadData: async (_ciphertext: Buffer, _options: unknown) => undefined,
      };
      await fakeBlob.uploadData(ciphertext, {`,
    )
  );
  const fakeInjectedContainer = changeDocument("src/main.ts", (source) =>
    source.replace(
      "const uploader = new EncryptedBlobManager(containerClient, keyManager);",
      `const replacementContainer = {
    getBlockBlobClient: () => ({
      download: async () => ({ readableStreamBody: undefined }),
      getProperties: async () => ({ metadata: {} }),
      uploadData: async () => undefined,
    }),
  } as unknown as typeof containerClient;
  const uploader = new EncryptedBlobManager(replacementContainer, keyManager);`,
    )
  );
  const fakeInjectedKeyManager = changeDocument("src/main.ts", (source) =>
    source.replace(
      "const uploader = new EncryptedBlobManager(containerClient, keyManager);",
      `const replacementKeyManager = {
    unwrapDataEncryptionKey: async () => Buffer.alloc(32),
    wrapDataEncryptionKey: async () => ({
      keyId: "fabricated",
      wrappedDek: Buffer.from("fabricated", "utf8"),
    }),
  } as unknown as typeof keyManager;
  const uploader = new EncryptedBlobManager(containerClient, replacementKeyManager);`,
    )
  );
  const fakeInjectedUploader = changeDocument("src/main.ts", (source) =>
    source.replace(
      "const uploader = new EncryptedBlobManager(containerClient, keyManager);",
      `const replacementUploader = {} as unknown as EncryptedBlobManager;
  const uploader = replacementUploader;`,
    )
  );
  const fabricatedDecryption = changeDocument("src/encryptedBlobManager.ts", (source) =>
    source.replace(
      'return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");',
      'return "fabricated decrypted output";',
    )
  );
  const disconnectedUploadEvidence = changeDocument(
    "src/encryptedBlobManager.ts",
    (source) =>
      source
        .replace(
          "    const dataEncryptionKey = randomBytes(32);",
          `    const encrypt = process.env.ENCRYPT;
    if (encrypt) {
    const dataEncryptionKey = randomBytes(32);`,
        )
        .replace(
          "      await this.containerClient.getBlockBlobClient(blobName).uploadData(ciphertext, {",
          `    }
    if (!encrypt) {
      await this.containerClient.getBlockBlobClient(blobName).uploadData(ciphertext, {`,
        )
        .replace(
          '      });\n      return { keyId, wrappedDek: wrappedDek.toString("base64") };',
          `      });
    }
      return { keyId, wrappedDek: wrappedDek.toString("base64") };`,
        ),
  );

  for (const [label, workspace] of [
    ["constant early return", earlyReturn],
    ["download before upload", downloadBeforeUpload],
    ["concurrent upload and download", concurrentUploadAndDownload],
    ["unawaited upload before download", unawaitedUpload],
    ["mutually exclusive branches", mutuallyExclusive],
    ["mutually exclusive ternaries", ternaryExclusive],
    ["constant demo output", constantOutputs],
    ["overwritten operation output", overwrittenOutputs],
    ["overwritten operation output properties", overwrittenOutputProperties],
    ["fabricated metadata key ID", fabricatedKeyId],
    ["decorated metadata key ID", decoratedKeyId],
    ["CryptographyClient ignoring key IDs", ignoredCryptoKeyId],
    ["CryptographyClient decorating a key ID", decoratedCryptoKeyId],
    ["unsupported RSA algorithm variant", invalidKeyWrapAlgorithm],
    ["overwritten Key Vault key ID", overwrittenVaultKeyId],
    ["decorated stored key ID", decoratedStoredKeyId],
    ["augmented wrapped DEK result", augmentedWrapResult],
    ["augmented unwrapped DEK result", augmentedUnwrapResult],
    ["overwritten wrapped DEK result", overwrittenWrapResult],
    ["overwritten unwrapped DEK result", overwrittenUnwrapResult],
    ["fake Blob client", fakeBlobClient],
    ["fake injected Blob container", fakeInjectedContainer],
    ["fake injected key manager", fakeInjectedKeyManager],
    ["fake injected uploader", fakeInjectedUploader],
    ["fabricated decrypted output", fabricatedDecryption],
    ["path-incompatible upload evidence", disconnectedUploadEvidence],
  ]) {
    rejectsConnectedRoundTrip(workspace, label);
  }
});

test("connected helper, split-ciphertext, alias, and RSA-OAEP-256 forms remain valid", () => {
  const alternate = changeDocuments({
    "src/encryptedBlobManager.ts": (source) =>
      source
        .replace(
          'const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);',
          `const encryptedPrefix = cipher.update(plaintext, "utf8");
    const encryptedSuffix = cipher.final();
    const ciphertext = Buffer.concat([encryptedPrefix, encryptedSuffix]);`,
        )
        .replace(
          "const authenticationTag = cipher.getAuthTag();",
          `const generatedAuthenticationTag = cipher.getAuthTag();
    const authenticationTag = generatedAuthenticationTag;`,
        ),
    "src/keyManager.ts": (source) => {
      const withHelperCalls = source
        .replaceAll(
          "new CryptographyClient(key.id, this.credential)",
          "this.createCryptographyClient(key.id)",
        )
        .replaceAll(
          "new CryptographyClient(keyId, this.credential)",
          "this.createCryptographyClient(keyId)",
        )
        .replaceAll('"RSA-OAEP"', "keyWrapAlgorithm");
      return withHelperCalls.replace(
        'type TokenCredential = ConstructorParameters<typeof KeyClient>[1];',
        `type TokenCredential = ConstructorParameters<typeof KeyClient>[1];
const keyWrapAlgorithm = "RSA-OAEP-256";`,
      ).replace(
        "  public async wrapDataEncryptionKey(",
        `  private createCryptographyClient(keyId: string): CryptographyClient {
    return new CryptographyClient(keyId, this.credential);
  }

  public async wrapDataEncryptionKey(`,
      );
    },
    "src/main.ts": (source) =>
      source
        .replace(
          'import { EncryptedBlobManager } from "./encryptedBlobManager.js";',
          `import { EncryptedBlobManager } from "./encryptedBlobManager.js";
import { KeyManager } from "./keyManager.js";
import type { ContainerClient } from "@azure/storage-blob";

function createUploader(
  containerClient: ContainerClient,
  keyManager: KeyManager,
): EncryptedBlobManager {
  return new EncryptedBlobManager(containerClient, keyManager);
}`,
        )
        .replace(
          "const uploader = new EncryptedBlobManager(containerClient, keyManager);",
          "const uploader = createUploader(containerClient, keyManager);",
        )
        .replace(
          `  console.log(\`Vault key ID: \${upload.keyId}\`);
  console.log(\`Wrapped DEK (base64): \${upload.wrappedDek}\`);
  console.log(\`Decrypted output: \${decrypted}\`);`,
          `  const actualKeyId = upload.keyId;
  const actualWrappedDek = upload.wrappedDek;
  const actualDecryptedOutput = decrypted;
  console.info(actualKeyId);
  console.info(actualWrappedDek);
  console.info(actualDecryptedOutput);`,
        ),
  });

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("RSA-OAEP-256 and value aliases preserve a connected encryption round trip", () => {
  const alternate = withDocuments(
    golden.documents.map((document) => {
      if (document.path === "src/keyManager.ts") {
        return {
          ...document,
          source: document.source.replaceAll('"RSA-OAEP"', '"RSA-OAEP-256"'),
        };
      }
      if (document.path === "src/encryptedBlobManager.ts") {
        return {
          ...document,
          source: document.source
            .replace(
              'const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);',
              `const encryptedBytes = Buffer.concat([
                cipher.update(plaintext, "utf8"),
                cipher.final(),
              ]);
              const ciphertext = encryptedBytes;`,
            )
            .replace(
              "const authenticationTag = cipher.getAuthTag();",
              `const generatedAuthenticationTag = cipher.getAuthTag();
              const authenticationTag = generatedAuthenticationTag;`,
            )
            .replace(
              "const metadata = properties.metadata;",
              `const downloadedMetadata = properties.metadata;
              const metadata = downloadedMetadata;`,
            )
            .replace(
              "const ciphertext = await streamToBuffer(download.readableStreamBody);",
              `const downloadedCiphertext = await streamToBuffer(download.readableStreamBody);
              const ciphertext = downloadedCiphertext;`,
            )
            .replace(
              'const wrappedDek = Buffer.from(metadata.wrappedDek, "base64");',
              `const downloadedWrappedDek = Buffer.from(metadata.wrappedDek, "base64");
              const wrappedDek = downloadedWrappedDek;`,
            )
            .replace(
              "const dataEncryptionKey = await this.keyManager.unwrapDataEncryptionKey(",
              "const recoveredDataEncryptionKey = await this.keyManager.unwrapDataEncryptionKey(",
            )
            .replace(
              "      const decipher = createDecipheriv(",
              "      const dataEncryptionKey = recoveredDataEncryptionKey;\n      const decipher = createDecipheriv(",
            ),
        };
      }
      return document;
    }),
  );

  for (const rule of [
    "prompt/key-vault-envelope-encryption",
    "prompt/encrypted-blob-metadata",
    "prompt/decrypt-path",
    "prompt/connected-round-trip",
  ]) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("arrow-function entrypoints and crypto factories remain valid", () => {
  const alternate = withDocuments(
    golden.documents.map((document) => {
      if (document.path === "src/keyManager.ts") {
        return {
          ...document,
          source: document.source
            .replace(
              'type TokenCredential = ConstructorParameters<typeof KeyClient>[1];',
              `type TokenCredential = ConstructorParameters<typeof KeyClient>[1];

const createCryptographyClient = (
  keyId: string,
  credential: TokenCredential,
): CryptographyClient => new CryptographyClient(keyId, credential);`,
            )
            .replaceAll(
              "new CryptographyClient(key.id, this.credential)",
              "createCryptographyClient(key.id, this.credential)",
            )
            .replaceAll(
              "new CryptographyClient(keyId, this.credential)",
              "createCryptographyClient(keyId, this.credential)",
            ),
        };
      }
      if (document.path === "src/main.ts") {
        return {
          ...document,
          source: document.source
            .replace(
              "async function main(): Promise<void> {",
              "const main = async (): Promise<void> => {",
            )
            .replace(
              /\r?\n}\r?\n\r?\nmain\(\)\.catch/,
              "\n};\n\nmain().catch",
            ),
        };
      }
      return document;
    }),
  );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("key-ID aliases preserve metadata and unwrap provenance", () => {
  const alternate = changeDocuments({
    "src/keyManager.ts": (source) =>
      source.replace(
        "return { keyId: key.id, wrappedDek: Buffer.from(result.result) };",
        `const vaultKeyId = key.id;
      return { keyId: vaultKeyId, wrappedDek: Buffer.from(result.result) };`,
      ),
    "src/encryptedBlobManager.ts": (source) =>
      source
        .replace(
          "      await this.containerClient.getBlockBlobClient(blobName).uploadData(ciphertext, {",
          `      const storedKeyId = keyId;
      await this.containerClient.getBlockBlobClient(blobName).uploadData(ciphertext, {`,
        )
        .replace(
          "          keyId,\n        },",
          "          keyId: storedKeyId,\n        },",
        )
        .replace(
          "      const download = await blobClient.download();",
          `      const recoveredKeyId = metadata.keyId;
      const download = await blobClient.download();`,
        )
        .replace(
          "        metadata.keyId,",
          "        recoveredKeyId,",
        ),
  });

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("key-object crypto factory preserves the Key Vault key ID", () => {
  const alternate = changeDocument("src/keyManager.ts", (source) =>
    source
      .replace(
        "new CryptographyClient(key.id, this.credential)",
        "this.createCryptographyClientForKey(key)",
      )
      .replace(
        "  public async wrapDataEncryptionKey(",
        `  private createCryptographyClientForKey(
    key: { id?: string },
  ): CryptographyClient {
    if (!key.id) throw new Error("The Key Vault key did not include an ID.");
    return new CryptographyClient(key.id, this.credential);
  }

  public async wrapDataEncryptionKey(`,
      ),
  );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("returned wrap-result object aliases preserve metadata provenance", () => {
  const alternate = changeDocument("src/encryptedBlobManager.ts", (source) =>
    source.replace(
      `const { keyId, wrappedDek } =
        await this.keyManager.wrapDataEncryptionKey(dataEncryptionKey);`,
      `const wrappingResult =
        await this.keyManager.wrapDataEncryptionKey(dataEncryptionKey);
      const keyId = wrappingResult.keyId;
      const wrappedDek = wrappingResult.wrappedDek;`,
    )
  );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("an awaited upload promise completes before decryption", () => {
  const alternate = changeDocument("src/main.ts", (source) =>
    source.replace(
      `  const upload = await uploader.uploadText(blobName, "Azure envelope encryption sample");
  const decrypted = await uploader.downloadText(blobName);`,
      `  const uploadPromise = uploader.uploadText(blobName, "Azure envelope encryption sample");
  const upload = await uploadPromise;
  const decrypted = await uploader.downloadText(blobName);`,
    )
  );

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("constant truthy early returns make the application work unreachable", () => {
  const blocker = (setup) =>
    changeDocument("src/main.ts", (source) =>
      source.replace(
        "  const { containerClient, keyManager } = createApplicationClients();",
        `${setup}
  const { containerClient, keyManager } = createApplicationClients();`,
      )
    );

  for (const [label, setup] of [
    ["Boolean coercion", "  if (Boolean(1)) return;"],
    ["double negation", "  if (!!1) return;"],
    ["truthy string literal", '  if ("always") return;'],
    ["truthy array literal", "  if ([]) return;"],
    ["constant comparison", "  if (1 === 1) return;"],
    ["constant logical expression", "  if (false || 1) return;"],
    [
      "constant aliases and coercion",
      `  const one = 1;
  const coerced = Boolean(one);
  const shouldReturn = coerced;
  if (shouldReturn) return;`,
    ],
  ]) {
    rejectsConnectedRoundTrip(blocker(setup), label);
  }
});

test("falsy and runtime early-return checks retain a viable path", () => {
  const alternate = (setup) =>
    changeDocument("src/main.ts", (source) =>
      source.replace(
        "  const { containerClient, keyManager } = createApplicationClients();",
        `${setup}
  const { containerClient, keyManager } = createApplicationClients();`,
      )
    );

  for (const [label, setup] of [
    ["falsy Boolean coercion", "  if (Boolean(0)) return;"],
    ["false comparison", "  if (1 === 0) return;"],
    ["falsy logical expression", "  if (false && Boolean(1)) return;"],
    [
      "runtime Boolean coercion",
      `  const shouldSkip = Boolean(process.env.SKIP_DEMO);
  if (shouldSkip) return;`,
    ],
  ]) {
    for (const rule of ruleNames()) {
      assert.equal(evaluateRule(rule, alternate(setup)), true, `${label}: ${rule}`);
    }
  }
});

test("decrypted output must be an exact UTF-8 decode without transformations", () => {
  const decrypted = 'Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")';
  const transformedReturn = (expression) =>
    changeDocument("src/encryptedBlobManager.ts", (source) =>
      source.replace(`return ${decrypted};`, `return ${expression};`)
    );

  for (const [label, expression] of [
    ["slice", `${decrypted}.slice(0)`],
    ["substring", `${decrypted}.substring(0)`],
    ["string concat", `${decrypted}.concat("")`],
    ["replacement", `${decrypted}.replace("Azure", "Azure")`],
    [
      "string decoration",
      '`decrypted ${Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")}`',
    ],
    ["string concatenation", `${decrypted} + ""`],
    ["non-UTF-8 decode", 'Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("hex")'],
    ["offset decode", 'Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8", 0)'],
  ]) {
    const workspace = transformedReturn(expression);
    assert.equal(evaluateRule("prompt/decrypt-path", workspace), false, label);
    assert.equal(evaluateRule("prompt/connected-round-trip", workspace), false, label);
  }
});

test("decrypted output transformations after download cannot satisfy the demo", () => {
  const transformedOutput = (expression) =>
    changeDocument("src/main.ts", (source) =>
      source
        .replace(
          "  const decrypted = await uploader.downloadText(blobName);",
          `  const decrypted = await uploader.downloadText(blobName);
  const displayed = ${expression};`,
        )
        .replace(
          "  console.log(`Decrypted output: ${decrypted}`);",
          "  console.log(`Decrypted output: ${displayed}`);",
        )
    );

  for (const [label, expression] of [
    ["slice", "decrypted.slice(0)"],
    ["substring", "decrypted.substring(0)"],
    ["string concat", 'decrypted.concat("")'],
    ["replacement", 'decrypted.replace("Azure", "Azure")'],
    ["string decoration", "`decrypted ${decrypted}`"],
  ]) {
    assert.equal(
      evaluateRule("prompt/connected-round-trip", transformedOutput(expression)),
      false,
      label,
    );
  }
});

test("exact decoded aliases and pass-through output remain valid", () => {
  const alternate = changeDocuments({
    "src/encryptedBlobManager.ts": (source) =>
      source.replace(
        'return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");',
        `const textEncoding = "utf-8";
      const decryptedBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const decoded = decryptedBytes.toString(textEncoding);
      const output = String(decoded);
      return output;`,
      ),
    "src/main.ts": (source) =>
      source
        .replace(
          "  const decrypted = await uploader.downloadText(blobName);",
          `  const decrypted = await uploader.downloadText(blobName);
  const displayed = String(decrypted);`,
        )
        .replace(
          "  console.log(`Decrypted output: ${decrypted}`);",
          "  console.log(`Decrypted output: ${displayed}`);",
        ),
  });

  for (const rule of ruleNames()) {
    assert.equal(evaluateRule(rule, alternate), true, rule);
  }
});

test("downloaded ciphertext and encryption metadata retain exact provenance", () => {
  const transformed = (transform) =>
    changeDocument("src/encryptedBlobManager.ts", transform);

  for (const [label, workspace] of [
    [
      "ciphertext slice",
      transformed((source) =>
        source.replace("decipher.update(ciphertext)", "decipher.update(ciphertext.subarray(0))")
      ),
    ],
    [
      "wrapped DEK slice",
      transformed((source) =>
        source.replace("        wrappedDek,", "        wrappedDek.subarray(0),")
      ),
    ],
    [
      "initialization vector slice",
      transformed((source) =>
        source.replace(
          'Buffer.from(metadata.iv, "base64"),',
          'Buffer.from(metadata.iv, "base64").subarray(0),',
        )
      ),
    ],
    [
      "authentication tag slice",
      transformed((source) =>
        source.replace(
          'decipher.setAuthTag(Buffer.from(metadata.authTag, "base64"));',
          'decipher.setAuthTag(Buffer.from(metadata.authTag, "base64").subarray(0));',
        )
      ),
    ],
    [
      "key ID slice",
      transformed((source) =>
        source.replace("        metadata.keyId,", "        metadata.keyId.slice(0),")
      ),
    ],
  ]) {
    assert.equal(evaluateRule("prompt/decrypt-path", workspace), false, label);
    assert.equal(evaluateRule("prompt/connected-round-trip", workspace), false, label);
  }
});
